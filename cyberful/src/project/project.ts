// ── Project Identity And Lifecycle ─────────────────────────────────────────
// Resolves canonical project identity through bounded Git probes and persists
//   metadata without treating corrupt or inaccessible repositories as global.
// → cyberful/src/project/project.sql.ts — stores the canonical project records.
// → cyberful/src/project/instance-store.ts — scopes services to resolved projects.
// ──────────────────────────────────────────────────────────────────────

import { and, eq, sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import { ProjectTable } from "./project.sql"
import { SessionTable } from "../session/session.sql"
import * as Log from "@/util/log"
import { Flag } from "@/flag/flag"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { which } from "../util/which"
import { ProjectID } from "./schema"
import { Effect, Layer, Scope, Context, Types, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppFileSystem } from "@/effect/filesystem"
import { AppProcess } from "@/effect/process"
import { NonNegativeInt, optionalOmitUndefined } from "@/schema"
import { serviceUse } from "@/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Hash } from "@/util/hash"
import { errorMessage } from "@/util/error"
import path from "path"

const log = Log.create({ service: "project" })

const ProjectVcs = Schema.Literal("git")

const ProjectIcon = Schema.Struct({
  url: optionalOmitUndefined(Schema.String),
  override: optionalOmitUndefined(Schema.String),
  color: optionalOmitUndefined(Schema.String),
})

const ProjectTime = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
})

export const Info = Schema.Struct({
  id: ProjectID,
  worktree: Schema.String,
  vcs: optionalOmitUndefined(ProjectVcs),
  name: optionalOmitUndefined(Schema.String),
  icon: optionalOmitUndefined(ProjectIcon),
  time: ProjectTime,
}).annotate({ identifier: "Project" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const Event = {
  Updated: BusEvent.define("project.updated", Info),
}

type Row = typeof ProjectTable.$inferSelect

export function fromRow(row: Row): Info {
  const icon =
    row.icon_url || row.icon_url_override || row.icon_color
      ? {
          url: row.icon_url ?? undefined,
          override: row.icon_url_override ?? undefined,
          color: row.icon_color ?? undefined,
        }
      : undefined
  return {
    id: row.id,
    worktree: row.worktree,
    vcs: row.vcs ? Schema.decodeUnknownSync(ProjectVcs)(row.vcs) : undefined,
    name: row.name ?? undefined,
    icon,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  }
}

export const UpdateInput = Schema.Struct({
  projectID: ProjectID,
  name: Schema.optional(Schema.String),
  icon: Schema.optional(ProjectIcon),
})
export type UpdateInput = Types.DeepMutable<Schema.Schema.Type<typeof UpdateInput>>

export const UpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  icon: Schema.optional(ProjectIcon),
}).annotate({ identifier: "ProjectUpdateInput" })
export type UpdatePayload = Types.DeepMutable<Schema.Schema.Type<typeof UpdatePayload>>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Project.NotFoundError", {
  projectID: ProjectID,
}) {}

export class IdentityError extends Schema.TaggedErrorClass<IdentityError>()("Project.IdentityError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly fromDirectory: (directory: string) => Effect.Effect<{ project: Info; sandbox: string }, IdentityError>
  readonly discover: (input: Info) => Effect.Effect<void>
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: ProjectID) => Effect.Effect<Info | undefined>
  readonly update: (input: UpdateInput) => Effect.Effect<Info, NotFoundError>
  readonly initGit: (input: { directory: string; project: Info }) => Effect.Effect<Info, IdentityError>
}

export class Service extends Context.Service<Service, Interface>()("@cyberful/Project") {}

type GitResult = { code: number; text: string; stderr: string }
const GIT_TIMEOUT = "10 seconds"
const MAX_GIT_OUTPUT_BYTES = 128 * 1024

function identityFailure(operation: string, targetPath: string, cause: unknown) {
  return new IdentityError({
    operation,
    path: targetPath,
    message: `${operation}: ${targetPath}: ${errorMessage(cause)}`,
    cause,
  })
}

function gitFailure(args: readonly string[], result: GitResult, operation: string, targetPath: string) {
  return identityFailure(
    operation,
    targetPath,
    new AppProcess.AppProcessError({
      command: `git ${args.join(" ")}`,
      exitCode: result.code,
      stderr: result.stderr.trim() || result.text.trim() || `exit ${result.code}`,
    }),
  )
}

function cachedProjectID(contents: string, marker: string) {
  const value = contents.trim()
  if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Project identity marker is malformed: ${marker}`)
  }
  return ProjectID.make(value)
}

function originIsAbsent(result: GitResult) {
  return result.code !== 0 && /^error: No such remote ['"]origin['"]\s*$/i.test(result.stderr.trim())
}

function rootFailureMayBeUnborn(result: GitResult) {
  const detail = result.stderr.trim()
  return (
    result.code !== 0 &&
    (/ambiguous argument ['"]?HEAD['"]?: unknown revision or path not in the working tree/i.test(detail) ||
      /bad revision ['"]HEAD['"]/i.test(detail))
  )
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const processService = yield* AppProcess.Service
    const flags = yield* RuntimeFlags.Service

    // ── Git Identity Probes Are Bounded And Evidentiary ────────────
    // Project resolution runs on arbitrary working trees, so Git receives a
    // deadline and separate fixed capture limits before any output is parsed.
    // Scope closure owns termination and reaping on timeout or interruption.
    // Spawn, permission, and capture failures remain defects with their original
    // cause; only ordinary non-zero Git results are interpreted by the caller.
    // ─────────────────────────────────────────────────────────────────
    const git = Effect.fnUntraced(function* (args: string[], opts?: { cwd?: string }) {
      const result = yield* processService
        .run(
          ChildProcess.make("git", args, {
            cwd: opts?.cwd,
            env: { GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" },
            extendEnv: true,
            stdin: "ignore",
          }),
          {
            maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
            maxErrorBytes: MAX_GIT_OUTPUT_BYTES,
            timeout: GIT_TIMEOUT,
          },
        )
        .pipe(
          Effect.mapError((cause) =>
            identityFailure(`Could not execute git ${args.join(" ")}`, opts?.cwd ?? ".", cause),
          ),
        )
      if (result.stdoutTruncated || result.stderrTruncated) {
        return yield* identityFailure(
          `Git identity probe exceeded ${MAX_GIT_OUTPUT_BYTES} bytes: git ${args.join(" ")}`,
          opts?.cwd ?? ".",
          new Error("Git output was truncated before identity could be proven"),
        )
      }
      return {
        code: result.exitCode,
        text: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      } satisfies GitResult
    })

    const resolveProject = Effect.fn("Project.resolveIdentity")(function* (directory: string) {
      const dotgit = (yield* fs
        .up({ targets: [".git"], start: directory })
        .pipe(Effect.mapError((cause) => identityFailure("Could not search for Git metadata", directory, cause))))[0]
      if (!dotgit) return { id: ProjectID.global, directory, vcs: undefined }

      const cwd = path.dirname(dotgit)
      const [topLevel, commonDir] = yield* Effect.all([
        git(["rev-parse", "--show-toplevel"], { cwd }),
        git(["rev-parse", "--git-common-dir"], { cwd }),
      ])
      if (topLevel.code !== 0) {
        return yield* gitFailure(["rev-parse", "--show-toplevel"], topLevel, "Could not resolve Git worktree", cwd)
      }
      if (commonDir.code !== 0) {
        return yield* gitFailure(["rev-parse", "--git-common-dir"], commonDir, "Could not resolve Git metadata", cwd)
      }

      if (!topLevel.text.trim()) {
        return yield* identityFailure(
          "Could not resolve Git worktree",
          cwd,
          new Error("git rev-parse returned an empty worktree path"),
        )
      }
      if (!commonDir.text.trim()) {
        return yield* identityFailure(
          "Could not resolve Git metadata",
          cwd,
          new Error("git rev-parse returned an empty common directory"),
        )
      }
      const repository = resolveGitPath(cwd, topLevel.text)
      const store = resolveGitPath(cwd, commonDir.text)
      const marker = path.join(store, "cyberful")
      const markerContents = yield* fs.readFileString(marker).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
        Effect.mapError((cause) => identityFailure("Could not read project identity marker", marker, cause)),
      )
      const previous =
        markerContents !== undefined
          ? yield* Effect.try({
              try: () => cachedProjectID(markerContents, marker),
              catch: (cause) => identityFailure("Could not parse project identity marker", marker, cause),
            })
          : undefined
      const origin = yield* git(["remote", "get-url", "origin"], { cwd: repository })
      if (origin.code !== 0 && !originIsAbsent(origin)) {
        return yield* gitFailure(["remote", "get-url", "origin"], origin, "Could not inspect Git origin", repository)
      }
      const remote = origin.code === 0 ? normalizeGitRemote(origin.text) : undefined
      const roots = yield* git(["rev-list", "--max-parents=0", "HEAD"], { cwd: repository })
      if (roots.code !== 0) {
        if (!rootFailureMayBeUnborn(roots)) {
          return yield* gitFailure(
            ["rev-list", "--max-parents=0", "HEAD"],
            roots,
            "Could not resolve Git root commit",
            repository,
          )
        }
        const [head, references] = yield* Effect.all([
          git(["symbolic-ref", "--quiet", "HEAD"], { cwd: repository }),
          git(["for-each-ref", "--format=%(objectname)"], { cwd: repository }),
        ])
        if (head.code !== 0 || references.code !== 0 || references.stderr.trim()) {
          return yield* gitFailure(
            ["rev-list", "--max-parents=0", "HEAD"],
            roots,
            "Could not resolve Git root commit",
            repository,
          )
        }
      }
      const root = roots.text
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
        .toSorted()[0]
      if (roots.code === 0 && !root) {
        return yield* identityFailure(
          "Could not resolve Git root commit",
          repository,
          new Error("git rev-list returned no root commits"),
        )
      }

      return {
        previous,
        id: remote ? ProjectID.make(Hash.fast(`git-remote:${remote}`)) : (previous ?? ProjectID.make(root ?? "global")),
        directory: repository,
        vcs: { type: "git" as const, store },
      }
    })

    const db = <T>(fn: (database: Database.TxOrDb) => T) => Effect.sync(() => Database.use(fn))

    const emitUpdated = (data: Info) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          project: data.id,
          payload: { type: Event.Updated.type, properties: data },
        }),
      )

    const fakeVcs = Schema.decodeUnknownSync(Schema.optional(ProjectVcs))(Flag.CYBERFUL_FAKE_VCS)

    const scope = yield* Scope.Scope

    const migrateProjectId = Effect.fn("Project.migrateProjectId")(function* (
      oldID: ProjectID | undefined,
      newID: ProjectID,
    ) {
      if (!oldID) return
      if (oldID === ProjectID.global) return
      if (oldID === newID) return

      yield* Effect.sync(() =>
        Database.transaction(
          (d) => {
            const oldProject = d.select().from(ProjectTable).where(eq(ProjectTable.id, oldID)).get()
            const newProject = d.select().from(ProjectTable).where(eq(ProjectTable.id, newID)).get()
            if (oldProject && !newProject) {
              d.insert(ProjectTable)
                .values({
                  ...oldProject,
                  id: newID,
                  time_updated: Date.now(),
                })
                .run()
            }

            d.update(SessionTable)
              .set({ project_id: newID, time_updated: sql`${SessionTable.time_updated}` })
              .where(eq(SessionTable.project_id, oldID))
              .run()

            if (oldProject) d.delete(ProjectTable).where(eq(ProjectTable.id, oldID)).run()
          },
          { behavior: "immediate" },
        ),
      )
    })

    const fromDirectory = Effect.fn("Project.fromDirectory")(function* (directory: string) {
      log.info("fromDirectory", { directory })

      const data = yield* resolveProject(directory)
      const worktree = data.id === ProjectID.global && !data.vcs ? "/" : data.directory

      const projectID = data.id
      yield* migrateProjectId(data.previous, projectID)
      const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get())
      const existing = row
        ? fromRow(row)
        : {
            id: projectID,
            worktree,
            vcs: data.vcs?.type ?? fakeVcs,
            time: { created: Date.now(), updated: Date.now() },
          }

      if (flags.experimentalIconDiscovery) {
        yield* discover(existing).pipe(
          Effect.catchCause((cause) => Effect.logWarning("project icon discovery failed", { cause })),
          Effect.forkIn(scope),
        )
      }

      const result: Info = {
        ...existing,
        worktree: projectID === ProjectID.global ? worktree : existing.worktree,
        vcs: data.vcs?.type ?? fakeVcs,
        time: { ...existing.time, updated: Date.now() },
      }

      yield* db((d) =>
        d
          .insert(ProjectTable)
          .values({
            id: result.id,
            worktree: result.worktree,
            vcs: result.vcs ?? null,
            name: result.name,
            icon_url: result.icon?.url,
            icon_url_override: result.icon?.override,
            icon_color: result.icon?.color,
            time_created: result.time.created,
            time_updated: result.time.updated,
          })
          .onConflictDoUpdate({
            target: ProjectTable.id,
            set: {
              worktree: result.worktree,
              vcs: result.vcs ?? null,
              name: result.name,
              icon_url: result.icon?.url,
              icon_url_override: result.icon?.override,
              icon_color: result.icon?.color,
              time_updated: result.time.updated,
            },
          })
          .run(),
      )

      if (projectID !== ProjectID.global) {
        yield* db((d) =>
          d
            .update(SessionTable)
            .set({ project_id: projectID })
            .where(and(eq(SessionTable.project_id, ProjectID.global), eq(SessionTable.directory, data.directory)))
            .run(),
        )
      }

      yield* emitUpdated(result)
      if (projectID !== ProjectID.global && data.vcs?.type === "git") {
        yield* fs
          .writeFileString(path.join(data.vcs.store, "cyberful"), data.id)
          .pipe(Effect.catchCause((cause) => Effect.logWarning("project identity marker write failed", { cause })))
      }
      return { project: result, sandbox: data.vcs ? data.directory : worktree }
    })

    const discover = Effect.fn("Project.discover")(function* (input: Info) {
      if (input.vcs !== "git") return
      if (input.icon?.override) return
      if (input.icon?.url) return

      const matches = yield* fs
        .glob("**/favicon.{ico,png,svg,jpg,jpeg,webp}", {
          cwd: input.worktree,
          absolute: true,
          include: "file",
        })
        .pipe(Effect.orDie)
      const shortest = matches.sort((a, b) => a.length - b.length)[0]
      if (!shortest) return

      const buffer = yield* fs.readFile(shortest).pipe(Effect.orDie)
      const base64 = Buffer.from(buffer).toString("base64")
      const mime = AppFileSystem.mimeType(shortest)
      const url = `data:${mime};base64,${base64}`
      yield* update({ projectID: input.id, icon: { url } }).pipe(
        Effect.catchTag("Project.NotFoundError", () => Effect.void),
      )
    })

    const list = Effect.fn("Project.list")(function* () {
      return yield* db((d) => d.select().from(ProjectTable).all().map(fromRow))
    })

    const get = Effect.fn("Project.get")(function* (id: ProjectID) {
      const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
      return row ? fromRow(row) : undefined
    })

    const update = Effect.fn("Project.update")(function* (input: UpdateInput) {
      const result = yield* db((d) =>
        d
          .update(ProjectTable)
          .set({
            name: input.name,
            icon_url: input.icon?.url,
            icon_url_override: input.icon?.override,
            icon_color: input.icon?.color,
            time_updated: Date.now(),
          })
          .where(eq(ProjectTable.id, input.projectID))
          .returning()
          .get(),
      )
      if (!result) return yield* new NotFoundError({ projectID: input.projectID })
      const data = fromRow(result)
      yield* emitUpdated(data)
      return data
    })

    const initGit = Effect.fn("Project.initGit")(function* (input: { directory: string; project: Info }) {
      if (input.project.vcs === "git") return input.project
      if (!(yield* Effect.sync(() => which("git")))) {
        return yield* identityFailure(
          "Could not initialize Git repository",
          input.directory,
          new Error("Git is not installed"),
        )
      }
      const result = yield* git(["init", "--quiet"], { cwd: input.directory })
      if (result.code !== 0) {
        return yield* gitFailure(["init", "--quiet"], result, "Could not initialize Git repository", input.directory)
      }
      const { project } = yield* fromDirectory(input.directory)
      return project
    })

    return Service.of({
      fromDirectory,
      discover,
      list,
      get,
      update,
      initGit,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

function resolveGitPath(cwd: string, value: string) {
  const normalized = AppFileSystem.windowsPath(value.replace(/[\r\n]+$/, ""))
  if (!normalized) return cwd
  return path.isAbsolute(normalized) ? path.normalize(normalized) : path.resolve(cwd, normalized)
}

function normalizeGitRemote(input: string) {
  const value = input.trim()
  if (!value) return undefined

  try {
    const parsed = new URL(value)
    if (parsed.protocol === "file:") return undefined
    return remoteParts(parsed.hostname, parsed.pathname)
  } catch {
    const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/)
    return scp ? remoteParts(scp[2], scp[3]) : undefined
  }
}

function remoteParts(host: string, name: string) {
  const pathname = name
    .replace(/^\/+/, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "")
  if (!host || !pathname) return undefined
  return `${host.toLowerCase()}/${pathname}`
}

export const use = serviceUse(Service)

export function list() {
  return Database.use((db) =>
    db
      .select()
      .from(ProjectTable)
      .all()
      .map((row) => fromRow(row)),
  )
}

export function get(id: ProjectID): Info | undefined {
  const row = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
  if (!row) return undefined
  return fromRow(row)
}

export * as Project from "./project"
