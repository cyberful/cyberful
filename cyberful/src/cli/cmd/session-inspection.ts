// ── Session Inspection And Observation Commands ────────────────
// Gives coding agents one snapshot command for local or attached state and one
// attached live stream with reconnect/resnapshot and terminal closeout ordering.
// → cyberful/src/session/inspection.ts — owns the snapshot meaning.
// → cyberful/src/cli/observation.ts — owns the versioned event projection.
// @docs/user-guide/cyberful-skill.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { EOL } from "node:os"
import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { createControlPlaneClient, type ControlPlaneClient, type SessionInspectionV1 } from "@/server/client"
import { createLocalControlPlaneClient } from "@/server/client/local"
import { ServerAuth } from "@/server/auth"
import { errorMessage } from "@/util/error"
import {
  createObservationEmitter,
  formatObservationText,
  inspectionCandidate,
  normalizeEventV1,
  writeObservationJson,
  type CyberfulObservationV1,
} from "../observation"

type ConnectionArgs = {
  readonly sessionID: string
  readonly attach?: string
  readonly dir?: string
  readonly password?: string
  readonly username?: string
}

type SessionInspectArgs = ConnectionArgs & { readonly format: string }
type SessionWatchArgs = ConnectionArgs & { readonly format: string }

function client(args: ConnectionArgs): ControlPlaneClient {
  if (!args.attach) return createLocalControlPlaneClient({ directory: args.dir })
  return createControlPlaneClient({
    baseUrl: args.attach,
    directory: args.dir,
    headers: ServerAuth.headers({ password: args.password, username: args.username }),
  })
}

async function inspection(sdk: ControlPlaneClient, sessionID: string, live: boolean): Promise<SessionInspectionV1> {
  const response = await sdk.session.inspection(
    { sessionID, live: live ? "true" : "false" },
    { throwOnError: true, signal: AbortSignal.timeout(15_000) },
  )
  if (!response.data) throw new Error(`Session inspection returned no snapshot for ${sessionID}.`)
  return response.data
}

function outcomeExitCode(snapshot: SessionInspectionV1): 0 | 1 | undefined {
  const outcome = snapshot.completion?.outcome ?? snapshot.lifecycle?.sessionOutcome
  if (outcome === "success" || outcome === "warning") return 0
  if (outcome === "blocked" || outcome === "failed") return 1
}

function terminal(snapshot: SessionInspectionV1): boolean {
  return (
    snapshot.source.status?.type === "idle" &&
    (snapshot.completion !== undefined || snapshot.lifecycle?.sessionStatus !== undefined)
  )
}

function numeric(value: number | string | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "n/a"
}

export function formatInspectionTable(snapshot: SessionInspectionV1): string {
  const rows: Array<[string, string]> = [
    ["Session", snapshot.session.id],
    ["Title", snapshot.session.title],
    ["Workflow", snapshot.session.workflow ?? "not available"],
    ["Source", `${snapshot.source.mode} (${snapshot.source.connection})`],
    ["Live status", snapshot.source.status?.type ?? "not attached"],
    ["Phase", snapshot.lifecycle?.phase ?? "not available"],
    ["Lifecycle", snapshot.completion?.outcome ?? snapshot.lifecycle?.status ?? "not available"],
    ["Freshness", snapshot.lifecycle ? `${numeric(snapshot.lifecycle.freshnessMs)} ms` : "not available"],
    ["Actors", `${numeric(snapshot.actors.running)} running / ${numeric(snapshot.actors.total)} total`],
    ["Findings", snapshot.findings ? `${numeric(snapshot.findings.currentCount)} current` : "not available"],
    ["Hypotheses", snapshot.hypotheses ? `${numeric(snapshot.hypotheses.activeCount)} active` : "not available"],
    ["Approvals", `${snapshot.approvals.length} pending`],
    ["Diagnostics", `${snapshot.diagnostics.length}`],
  ]
  const width = Math.max(...rows.map(([label]) => label.length))
  const lines = rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`)
  if (snapshot.findings?.current.length) {
    lines.push("", "Current findings")
    for (const finding of snapshot.findings.current) {
      lines.push(`- [${finding.technicalState ?? finding.review}] ${finding.title} (${finding.severity})`)
    }
  }
  if (snapshot.approvals.length) {
    lines.push("", "Human approvals")
    for (const approval of snapshot.approvals) {
      lines.push(`- ${approval.id}: ${approval.questions.map((question) => question.question).join(" / ")}`)
    }
  }
  if (snapshot.diagnostics.length) {
    lines.push("", "Diagnostics")
    for (const item of snapshot.diagnostics) lines.push(`- ${item.component}/${item.code}: ${item.message}`)
  }
  return lines.join(EOL)
}

const connectionOptions = <T>(yargs: import("yargs").Argv<T>, attachRequired: boolean) =>
  yargs
    .option("attach", {
      describe: "control-plane URL exposed by starting the TUI with --port, e.g. http://localhost:4096",
      type: "string",
      demandOption: attachRequired,
    })
    .option("dir", { describe: "instance directory used for routing", type: "string" })
    .option("password", {
      alias: "p",
      type: "string",
      describe: "basic auth password (defaults to CYBERFUL_SERVER_PASSWORD)",
    })
    .option("username", {
      alias: "u",
      type: "string",
      describe: "basic auth username (defaults to CYBERFUL_SERVER_USERNAME or 'cyberful')",
    })

export const SessionInspectCommand = effectCmd<SessionInspectArgs, void>({
  command: "inspect <sessionID>",
  describe: "inspect live and durable facts for a session",
  instance: (args) => !args.attach,
  directory: (args) => (args.dir && !args.attach ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs) =>
    connectionOptions(
      yargs.positional("sessionID", {
        describe: "session ID",
        type: "string",
        demandOption: true,
      }),
      false,
    ).option("format", { describe: "output format", type: "string", choices: ["table", "json"], default: "table" }),
  handler: Effect.fn("Cli.session.inspect")(function* (args) {
    const snapshot = yield* Effect.tryPromise({
      try: () => inspection(client(args), args.sessionID, Boolean(args.attach)),
      catch: (error) => new Error(errorMessage(error)),
    }).pipe(Effect.catch((error) => fail(error.message)))
    process.stdout.write(`${args.format === "json" ? JSON.stringify(snapshot, null, 2) : formatInspectionTable(snapshot)}${EOL}`)
  }),
})

function writer(format: "text" | "json") {
  return (observation: CyberfulObservationV1) => {
    if (format === "json") return writeObservationJson(observation)
    process.stdout.write(`${formatObservationText(observation)}${EOL}`)
  }
}

async function waitForReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const finish = () => {
      signal.removeEventListener("abort", abort)
      resolve()
    }
    const timer = setTimeout(finish, delayMs)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

export interface WatchSessionInput {
  readonly sdk: ControlPlaneClient
  readonly sessionID: string
  readonly signal: AbortSignal
  readonly write: (observation: CyberfulObservationV1) => void
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>
  readonly onOutcome?: (code: 0 | 1) => void
}

export async function watchSession(input: WatchSessionInput): Promise<void> {
  const emitter = createObservationEmitter({ sessionID: input.sessionID, write: input.write })
  const sleep = input.sleep ?? waitForReconnect
  let stream: Awaited<ReturnType<ControlPlaneClient["event"]["subscribe"]>> | undefined
  let reconnectDelayMs = 1_000
  let disconnected = false

  const emitTerminal = (snapshot: SessionInspectionV1) => {
    emitter.candidate(inspectionCandidate(snapshot, "terminal"))
    const code = outcomeExitCode(snapshot)
    if (code !== undefined) input.onOutcome?.(code)
  }

  try {
    const initial = await inspection(input.sdk, input.sessionID, true)
    emitter.candidate(inspectionCandidate(initial, "initial"))
    if (terminal(initial)) {
      emitTerminal(initial)
      return
    }

    while (!input.signal.aborted) {
      stream = await input.sdk.event.subscribe(undefined, {
        signal: input.signal,
        onSseError: () => {
          disconnected = true
        },
        sseDefaultRetryDelay: 1_000,
        sseMaxRetryDelay: 30_000,
      })
      let endedOnIdle = false
      for await (const event of stream.stream) {
        if (input.signal.aborted) break
        let reconnected: SessionInspectionV1 | undefined
        if (disconnected) {
          reconnected = await inspection(input.sdk, input.sessionID, true)
          emitter.candidate(inspectionCandidate(reconnected, "reconnected"))
          disconnected = false
          reconnectDelayMs = 1_000
        }
        const candidate = normalizeEventV1(event, input.sessionID)
        if (candidate) emitter.candidate(candidate)
        if (
          event.type === "session.status" &&
          event.properties.sessionID === input.sessionID &&
          event.properties.status.type === "idle"
        ) {
          endedOnIdle = true
          const final = await inspection(input.sdk, input.sessionID, true)
          emitTerminal(final)
          break
        }
        if (reconnected && terminal(reconnected)) {
          endedOnIdle = true
          emitTerminal(reconnected)
          break
        }
      }
      await stream.stream.return().catch(() => undefined)
      stream = undefined
      if (endedOnIdle || input.signal.aborted) break
      await sleep(reconnectDelayMs, input.signal).catch((error) => {
        if (!input.signal.aborted) throw error
      })
      if (input.signal.aborted) break
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000)
      const reconnected = await inspection(input.sdk, input.sessionID, true)
      emitter.candidate(inspectionCandidate(reconnected, "reconnected"))
      if (terminal(reconnected)) {
        emitTerminal(reconnected)
        break
      }
    }
  } catch (error) {
    if (!input.signal.aborted) emitter.emit("session.error", { name: "WatchError", message: "Session watch failed." })
    throw error
  } finally {
    await stream?.stream.return().catch(() => undefined)
  }
}

async function watch(args: ConnectionArgs & { readonly attach: string; readonly format: "text" | "json" }) {
  const abort = new AbortController()
  const cancel = () => abort.abort(new Error("Session watch interrupted."))
  process.once("SIGINT", cancel)
  process.once("SIGTERM", cancel)
  try {
    await watchSession({
      sdk: client(args),
      sessionID: args.sessionID,
      signal: abort.signal,
      write: writer(args.format),
      onOutcome: (code) => {
        process.exitCode = code
      },
    })
  } finally {
    abort.abort(new Error("Session watch complete."))
    process.removeListener("SIGINT", cancel)
    process.removeListener("SIGTERM", cancel)
  }
}

export const SessionWatchCommand = effectCmd<SessionWatchArgs, void>({
  command: "watch <sessionID>",
  describe: "watch one attached session as redacted observations",
  instance: false,
  builder: (yargs) =>
    connectionOptions(
      yargs.positional("sessionID", {
        describe: "session ID",
        type: "string",
        demandOption: true,
      }),
      true,
    ).option("format", { describe: "output format", type: "string", choices: ["text", "json"], default: "text" }),
  handler: Effect.fn("Cli.session.watch")(function* (args) {
    yield* Effect.tryPromise({
      try: () =>
        watch({
          ...args,
          attach: args.attach as string,
          format: args.format as "text" | "json",
        }),
      catch: (error) => new Error(errorMessage(error)),
    }).pipe(Effect.catch((error) => fail(error.message)))
  }),
})
