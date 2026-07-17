// ── Project Identity Persistence Tests ────────────────────────────────────
// Verifies canonical Git-root identity, legacy identifier adoption, and session reassignment.
// → cyberful/src/project/project.ts — resolves and persists the identities under test.
// ──────────────────────────────────────────────────────────────────────

import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"

const previousDatabase = process.env.CYBERFUL_DB
process.env.CYBERFUL_DB = ":memory:"
const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)

const Project = await import("./project")
const { ProjectID } = await import("./schema")
const { Database } = await import("@/storage/db")
const { Hash } = await import("@/util/hash")
const { ProjectTable } = await import("./project.sql")
const { SessionTable } = await import("@/session/session.sql")
const { SessionID } = await import("@/session/schema")
const { eq } = await import("drizzle-orm")

async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
  return stdout.trim()
}

async function repository() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cyberful-project-"))
  await git(directory, "init", "--quiet")
  await git(directory, "config", "user.email", "cyberful-test@example.invalid")
  await git(directory, "config", "user.name", "Cyberful Test")
  await writeFile(path.join(directory, "README.md"), "test\n")
  await git(directory, "add", "README.md")
  await git(directory, "commit", "--quiet", "-m", "initial")
  return directory
}

function resolve(directory: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Project.Service).fromDirectory(directory)
    }).pipe(Effect.provide(Project.defaultLayer), Effect.scoped),
  )
}

afterAll(() => {
  Database.close()
  stderr.mockRestore()
  if (previousDatabase === undefined) delete process.env.CYBERFUL_DB
  else process.env.CYBERFUL_DB = previousDatabase
})

describe("project identity", () => {
  test("does not collapse corrupt Git metadata into the global project", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cyberful-project-corrupt-"))
    try {
      await writeFile(path.join(directory, ".git"), "this is not a gitdir\n")
      await expect(resolve(directory)).rejects.toThrow("Could not resolve Git worktree")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("does not derive a global identity from a corrupt Git HEAD", async () => {
    const directory = await repository()
    try {
      const head = await git(directory, "symbolic-ref", "--quiet", "HEAD")
      await writeFile(path.join(directory, ".git", head), "not-an-object-id\n")
      await expect(resolve(directory)).rejects.toThrow("Could not resolve Git root commit")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects a malformed persisted identity instead of silently replacing it", async () => {
    const directory = await repository()
    try {
      await writeFile(path.join(directory, ".git", "cyberful"), "\n")
      await expect(resolve(directory)).rejects.toThrow("Project identity marker is malformed")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0))(
    "propagates an inaccessible identity marker instead of silently replacing it",
    async () => {
      const directory = await repository()
      const marker = path.join(directory, ".git", "cyberful")
      try {
        await writeFile(marker, "permission-protected\n")
        await chmod(marker, 0)
        await expect(resolve(directory)).rejects.toThrow()
      } finally {
        await chmod(marker, 0o600).catch(() => undefined)
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  test("prefers the normalized origin remote and persists it in the repository cache", async () => {
    const directory = await repository()
    try {
      await git(directory, "remote", "add", "origin", "git@GitHub.COM:Cyberful/Workbench.git")
      const result = await resolve(directory)
      const expected = Hash.fast("git-remote:github.com/Cyberful/Workbench")
      expect(String(result.project.id)).toBe(expected)
      expect(result.project.vcs).toBe("git")
      expect(result.sandbox).toBe(await realpath(directory))
      expect((await readFile(path.join(directory, ".git", "cyberful"), "utf8")).trim()).toBe(expected)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("uses the cached identity when no supported remote exists", async () => {
    const directory = await repository()
    try {
      await writeFile(path.join(directory, ".git", "cyberful"), "cached-project\n")
      expect(String((await resolve(directory)).project.id)).toBe("cached-project")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("falls back to the first root commit when no remote or cache exists", async () => {
    const directory = await repository()
    try {
      const root = await git(directory, "rev-list", "--max-parents=0", "HEAD")
      expect(String((await resolve(directory)).project.id)).toBe(root)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("recognizes a newly initialized repository before its first commit", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cyberful-project-unborn-"))
    try {
      await git(directory, "init", "--quiet")
      const result = await resolve(directory)
      expect(result.project.vcs).toBe("git")
      expect(result.sandbox).toBe(await realpath(directory))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("migrates persisted projects and sessions from a cached ID to a remote ID", async () => {
    const directory = await repository()
    const previous = ProjectID.make("legacy-project")
    const sessionID = SessionID.make("ses_project_identity_migration")
    try {
      await writeFile(path.join(directory, ".git", "cyberful"), `${previous}\n`)
      await git(directory, "remote", "add", "origin", "https://github.com/cyberful/workbench.git")
      Database.use((db) => {
        db.insert(ProjectTable).values({ id: previous, worktree: directory, vcs: "git" }).run()
        db.insert(SessionTable)
          .values({
            id: sessionID,
            project_id: previous,
            slug: "migration",
            directory,
            title: "migration",
            version: "0",
          })
          .run()
      })

      const expected = ProjectID.make(Hash.fast("git-remote:github.com/cyberful/workbench"))
      expect((await resolve(directory)).project.id).toBe(expected)
      Database.use((db) => {
        expect(db.select().from(ProjectTable).where(eq(ProjectTable.id, previous)).get()).toBeUndefined()
        expect(db.select().from(ProjectTable).where(eq(ProjectTable.id, expected)).get()?.id).toBe(expected)
        expect(db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()?.project_id).toBe(expected)
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("uses the global project outside Git", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cyberful-project-global-"))
    try {
      const result = await resolve(directory)
      expect(result.project.id).toBe(ProjectID.global)
      expect(result.project.worktree).toBe("/")
      expect(result.sandbox).toBe("/")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
