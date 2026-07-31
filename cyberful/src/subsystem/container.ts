// ── Engagement Container Ownership ──────────────────────────────
// Tracks cyberful-os containers activated by this process and reaps survivors on
// cooperative shutdown, with a synchronous process-exit cleanup backstop.
// → cyberful/src/subsystem/phase-runner.ts — registers per-engagement container ownership.
// → cyberful/src/session/prompt.ts — verifies session-scoped absence before closure.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

// ── Containers Outlive Subsystem Process Trees ───────────────────
// Each engagement uses a detached cyberful-os container whose Docker daemon lifetime
// is independent from the in-process Pi owner and the gateway process group.
// Clean workflow exit removes it directly, but interruption can stop the owning
// Cyberful process before teardown runs. This registry therefore remembers the
// deterministic container name and lets the host shutdown funnel reap every
// survivor; process exit retains a synchronous last resort. Removing the
// container never removes its host workarea bind mount.
// ─────────────────────────────────────────────────────────────────
import {
  MANAGED_LABEL,
  RUN_OWNER_LABEL,
  SESSION_LABEL,
  runOwnerToken,
} from "@/util/container-ownership"

export const OWNER_LABEL = RUN_OWNER_LABEL
export const EXPERT_RUNTIME = "expert"

const live = new Set<string>()
const REAP_CONCURRENCY = 8
const SESSION_CLEANUP_ATTEMPTS = 3
const SESSION_CLEANUP_DELAY_MS = 100
const DOCKER_CLEANUP_TIMEOUT_MS = 30_000
const DOCKER_CLEANUP_OUTPUT_BYTES = 64 * 1024
let exitHookInstalled = false
const liveListeners = new Set<(containers: string[]) => void>()

type ReapOutcome = { failed: false } | { failed: true; error: unknown }

export class SessionContainerCleanupError extends AggregateError {
  readonly removed: readonly string[]
  readonly remaining: readonly string[]

  constructor(errors: readonly unknown[], removed: readonly string[], remaining: readonly string[]) {
    super(errors, "one or more engagement containers failed to stop")
    this.name = "SessionContainerCleanupError"
    this.removed = removed
    this.remaining = remaining
  }
}

// ── Container Absence Is A Successful Cleanup Result ─────────────
// A container may already be gone when normal completion and process shutdown
// race, and Docker itself is optional before a runtime has started. Those two
// cases are idempotent success. Every other Docker failure remains visible to
// the cleanup owner, which can retain the name for a later process backstop.
// ─────────────────────────────────────────────────────────────────
async function dockerRm(name: string): Promise<void> {
  if (!Bun.which("docker")) return
  const proc = Bun.spawn(["docker", "rm", "-f", name], {
    stdout: "ignore",
    stderr: "pipe",
    timeout: DOCKER_CLEANUP_TIMEOUT_MS,
    maxBuffer: DOCKER_CLEANUP_OUTPUT_BYTES,
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0 && !stderr.includes("No such container")) {
    const detail = stderr.trim()
    throw new Error(`failed to remove Cyberful container ${name} (exit ${code})${detail ? `: ${detail}` : ""}`)
  }
}

let reaper: (name: string) => Promise<void> = dockerRm

// ── Run Ownership Survives A Lost In-Memory Registry ──────────────
// A Docker request can finish after the launching gateway has been interrupted.
// Such a late container never reaches `remember`, so normal name-based cleanup
// cannot discover it. The MCP stamps a one-way digest of the host run identity;
// shutdown can then find only this run's Expert containers without publishing the
// raw identifier or touching another concurrent Cyberful process.
// ────────────────────────────────────────────────────────────────
export function ownerToken(runID = process.env.CYBERFUL_RUN_ID?.trim()): string | undefined {
  return runOwnerToken(runID)
}

export function ownerFilterArguments(runID = process.env.CYBERFUL_RUN_ID?.trim()): string[] {
  const owner = ownerToken(runID)
  if (!owner) return []
  return ["--filter", `label=${OWNER_LABEL}=${owner}`]
}

async function dockerOwnedContainers(runID?: string): Promise<string[]> {
  const filters = ownerFilterArguments(runID)
  if (filters.length === 0 || !Bun.which("docker")) return []
  const proc = Bun.spawn(["docker", "ps", "--all", "--quiet", ...filters], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: DOCKER_CLEANUP_TIMEOUT_MS,
    maxBuffer: DOCKER_CLEANUP_OUTPUT_BYTES,
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) {
    const detail = stderr.trim()
    throw new Error(`failed to list run-owned Cyberful containers (exit ${code})${detail ? `: ${detail}` : ""}`)
  }
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((id) => {
      if (!/^[a-f0-9]{12,64}$/i.test(id)) throw new Error("Docker returned an invalid owned container id")
      return id
    })
}

let ownedContainerLister: (runID?: string) => Promise<string[]> = dockerOwnedContainers
let sessionContainerLister: (sessionID: string, runID?: string) => Promise<string[]> =
  dockerSessionContainers
let cleanupDelay: (delayMs: number) => Promise<void> = (delayMs) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs)
    timer.unref?.()
  })

function validSessionID(sessionID: string): string {
  const normalized = sessionID.trim()
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(normalized))
    throw new Error("Cyberful session id cannot be used as a Docker ownership filter")
  return normalized
}

async function dockerSessionContainers(sessionID: string, runID?: string): Promise<string[]> {
  if (!Bun.which("docker")) return []
  const filters = [
    "--filter",
    `label=${MANAGED_LABEL}`,
    ...ownerFilterArguments(runID),
  ]
  const proc = Bun.spawn(
    [
      "docker",
      "ps",
      "--all",
      "--quiet",
      ...filters,
      "--filter",
      `label=${SESSION_LABEL}=${validSessionID(sessionID)}`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: DOCKER_CLEANUP_TIMEOUT_MS,
      maxBuffer: DOCKER_CLEANUP_OUTPUT_BYTES,
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) {
    const detail = stderr.trim()
    throw new Error(`failed to list session-owned Cyberful containers (exit ${code})${detail ? `: ${detail}` : ""}`)
  }
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((id) => {
      if (!/^[a-f0-9]{12,64}$/i.test(id)) throw new Error("Docker returned an invalid session container id")
      return id
    })
}

// ── Force-Fresh Reaping Preserves Future Ownership ───────────────
// A new engagement removes any survivor before recreating its deterministic
// container name. That preliminary reap must not unregister the name because
// interruption can occur between removal and recreation. The shutdown owner
// therefore retains responsibility until normal terminal cleanup succeeds.
// ─────────────────────────────────────────────────────────────────
export function reap(name: string): Promise<void> {
  return reaper(name)
}

// ── First Ownership Installs A Synchronous Exit Backstop ─────────
// Cooperative shutdown normally awaits every removal, but fatal process exit
// cannot run asynchronous finalizers. The first remembered container installs
// one synchronous backstop for all later names. Repeated phase registration is
// idempotent because deterministic names share the same process ownership entry.
// ─────────────────────────────────────────────────────────────────
export function remember(name: string): void {
  live.add(name)
  notifyLive()
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.once("exit", () => {
      for (const name of live) {
        try {
          const result = Bun.spawnSync(["docker", "rm", "-f", name], {
            stdout: "ignore",
            stderr: "pipe",
            timeout: DOCKER_CLEANUP_TIMEOUT_MS,
            maxBuffer: DOCKER_CLEANUP_OUTPUT_BYTES,
          })
          const stderr = result.stderr.toString("utf8")
          if (result.exitCode !== 0 && !stderr.includes("No such container")) {
            process.stderr.write(`Unable to reap cyberful-os container ${name} during process exit: ${stderr.trim()}\n`)
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          process.stderr.write(`Unable to reap cyberful-os container ${name} during process exit: ${detail}\n`)
        }
      }
    })
  }
}

export async function remove(name: string): Promise<void> {
  await reaper(name)
  if (live.delete(name)) notifyLive()
}

// ── Failed Shutdown Work Remains Owned ───────────────────────────
// Shutdown attempts every remembered container in bounded batches so one Docker
// failure cannot prevent unrelated cleanup or create unbounded subprocess load.
// A name leaves the registry only after its reap succeeds. Aggregated failures
// therefore remain available to the main-process fallback and to diagnostics.
// ─────────────────────────────────────────────────────────────────
export async function removeAll(): Promise<void> {
  const names = Array.from(live)
  const failures: unknown[] = []
  for (let offset = 0; offset < names.length; offset += REAP_CONCURRENCY) {
    const outcomes = await Promise.all(
      names.slice(offset, offset + REAP_CONCURRENCY).map(async (name): Promise<ReapOutcome> => {
        try {
          await reaper(name)
          if (live.delete(name)) notifyLive()
          return { failed: false }
        } catch (error) {
          return { failed: true, error }
        }
      }),
    )
    for (const outcome of outcomes) if (outcome.failed) failures.push(outcome.error)
  }
  if (failures.length > 0) throw new AggregateError(failures, "one or more Cyberful containers could not be removed")
}

export async function removeOwned(runID = process.env.CYBERFUL_RUN_ID?.trim()): Promise<void> {
  const names = await ownedContainerLister(runID)
  const failures: unknown[] = []
  for (let offset = 0; offset < names.length; offset += REAP_CONCURRENCY) {
    const outcomes = await Promise.allSettled(names.slice(offset, offset + REAP_CONCURRENCY).map(reaper))
    failures.push(...outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : [])))
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "one or more run-owned Cyberful containers could not be removed")
}

// ── Session Closure Proves Its Disposable Containers Are Absent ───
// The generic cyberful-os dependency belongs to the worker process, while each
// expert container belongs to one engagement session. Exact deterministic names
// handle the normal path; immutable session and run-owner labels catch late
// creations after an interrupted gateway. Three bounded passes tolerate that
// race without touching another worker's containers, and the final label query
// turns any survivor into a visible terminal cleanup failure.
//
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────
export async function removeSession(
  sessionID: string,
  exactNames: readonly string[],
  runID = process.env.CYBERFUL_RUN_ID?.trim(),
): Promise<{ readonly removed: readonly string[]; readonly remaining: readonly string[] }> {
  validSessionID(sessionID)
  const targets = new Set(exactNames.map((name) => name.trim()).filter(Boolean))
  const removed = new Set<string>()
  let lastFailures: unknown[] = []

  for (let attempt = 1; attempt <= SESSION_CLEANUP_ATTEMPTS; attempt += 1) {
    let discovered: string[] = []
    const discoveryFailures: unknown[] = []
    try {
      discovered = await sessionContainerLister(sessionID, runID)
    } catch (error) {
      discoveryFailures.push(error)
    }
    for (const name of discovered) targets.add(name)
    const attempted = [...targets]
    const outcomes = await Promise.allSettled(attempted.map(reaper))
    lastFailures = [
      ...discoveryFailures,
      ...outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      ),
    ]
    outcomes.forEach((outcome, index) => {
      const name = attempted[index]
      if (outcome.status === "fulfilled" && name) removed.add(name)
    })
    if (attempt < SESSION_CLEANUP_ATTEMPTS)
      await cleanupDelay(SESSION_CLEANUP_DELAY_MS)
  }

  let remaining: string[] = []
  try {
    remaining = await sessionContainerLister(sessionID, runID)
  } catch (error) {
    lastFailures = [...lastFailures, error]
  }
  if (remaining.length > 0 || lastFailures.length > 0)
    throw new SessionContainerCleanupError(
      [
        ...lastFailures,
        ...(remaining.length > 0
          ? [new Error(`${remaining.length} session-owned Cyberful container(s) remain after cleanup`)]
          : []),
      ],
      [...removed].toSorted(),
      remaining,
    )

  for (const name of targets) if (live.delete(name)) notifyLive()
  return {
    removed: [...removed].toSorted(),
    remaining: [],
  }
}

// ── Shutdown Rechecks Docker After Registry Cleanup ───────────────────
// The first pass handles known containers. The label sweep then catches a
// container created by an already-dispatched Docker request after that pass.
// A final registry pass converts transient failures into idempotent success once
// discovery removed the underlying object, while retaining real failures.
// ────────────────────────────────────────────────────────────────
export async function removeForShutdown(runID = process.env.CYBERFUL_RUN_ID?.trim()): Promise<void> {
  await removeAll().catch(() => {})
  const failures: unknown[] = []
  await removeOwned(runID).catch((error) => failures.push(error))
  await removeAll().catch((error) => failures.push(error))
  if (failures.length > 0) throw new AggregateError(failures, "Cyberful container shutdown failed")
}

export function liveCount(): number {
  return live.size
}

export function onLiveChange(listener: (containers: string[]) => void): () => void {
  liveListeners.add(listener)
  listener([...live])
  return () => {
    liveListeners.delete(listener)
  }
}

function notifyLive(): void {
  const containers = [...live]
  for (const listener of liveListeners) listener(containers)
}

export function setReaperForTests(fn: (name: string) => Promise<void>): void {
  reaper = fn
  live.clear()
  notifyLive()
}

export function setOwnedContainerListerForTests(fn: (runID?: string) => Promise<string[]>): void {
  ownedContainerLister = fn
}

export function setSessionContainerListerForTests(
  fn: (sessionID: string, runID?: string) => Promise<string[]>,
): void {
  sessionContainerLister = fn
}

export function setCleanupDelayForTests(fn: (delayMs: number) => Promise<void>): void {
  cleanupDelay = fn
}

export function resetTestDoubles(): void {
  reaper = dockerRm
  ownedContainerLister = dockerOwnedContainers
  sessionContainerLister = dockerSessionContainers
  cleanupDelay = (delayMs) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, delayMs)
      timer.unref?.()
    })
  live.clear()
  notifyLive()
}

export * as SubsystemContainer from "./container"
