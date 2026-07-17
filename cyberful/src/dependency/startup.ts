// ── External Dependency Lifecycle ───────────────────────────────
// Starts the configured cyberful-os runtime, deduplicates concurrent ownership,
// publishes live snapshots, and owns shutdown across completion and signals.
// → cyberful/src/dependency/config.ts — supplies canonical runtime commands and policy.
// → cyberful/src/effect/instance-state.ts — supplies the authorized workspace mount.
// ─────────────────────────────────────────────────────────────────

import { stat } from "node:fs/promises"
import * as Log from "@/util/log"
import { CYBERFUL_PROCESS_ROLE } from "@/util/cyberful-process"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { InstanceState } from "@/effect/instance-state"
import { cyberfulOsContainerCommand, cyberfulOsDir, shouldStartCyberfulOs } from "./config"
import { Effect } from "effect"
import { errorMessage } from "@/util/error"

const log = Log.create({ service: "dependency-startup" })
const cyberfulOsContainers = new Map<string, CyberfulOsEntry>()
const shutdownSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
const STOP_TIMEOUT_MS = 15_000
const TERMINATION_GRACE_MS = 1_000
let dependencyExitHooksInstalled = false
let dependencySignalShutdown: Promise<void> | undefined
let stopInFlight: Promise<void> | undefined
let stopping = false
const liveListeners = new Set<(containers: string[]) => void>()

export type CyberfulOsContainer = {
  command: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

type CyberfulOsEntry = {
  container: CyberfulOsContainer
  controller: AbortController
  key: string
  state: "starting" | "started" | "failed"
  stopRequested: boolean
  failure?: Error
  task: Promise<void>
}

type StartupNotices = {
  announce: (message: string) => Promise<void>
  failure: (error: unknown) => Promise<void>
}

export type ContainerRunner = (
  container: CyberfulOsContainer,
  action: "up" | "down",
  signal?: AbortSignal,
) => Promise<number>

function envValue(name: string) {
  const value = process.env[name]?.trim()
  if (!value) return
  return value
}

function signalExitCode(signal: (typeof shutdownSignals)[number]) {
  if (signal === "SIGHUP") return 129
  if (signal === "SIGINT") return 130
  return 143
}

function cyberfulOsContainerKey(container: CyberfulOsContainer) {
  return [container.cwd, container.command.join("\0"), container.env.CYBERFUL_OS_CONTAINER ?? "cyberful-os"].join("\0")
}

function cyberfulOsContainerOptions(container: CyberfulOsContainer) {
  return {
    cwd: container.cwd,
    env: container.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  } as const
}

async function runCyberfulOsContainer(container: CyberfulOsContainer, action: "up" | "down", signal?: AbortSignal) {
  signal?.throwIfAborted()
  const proc = Bun.spawn([...container.command, action], cyberfulOsContainerOptions(container))
  let escalation: NodeJS.Timeout | undefined
  const abort = () => {
    try {
      proc.kill("SIGTERM")
    } catch (error) {
      log.debug("cyberful-os command had already exited during cancellation", { action, error: errorMessage(error) })
      return
    }
    escalation = setTimeout(() => {
      try {
        proc.kill("SIGKILL")
      } catch (error) {
        log.debug("cyberful-os command exited before cancellation escalation", { action, error: errorMessage(error) })
      }
    }, TERMINATION_GRACE_MS)
    escalation.unref()
  }
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  try {
    const code = await proc.exited
    signal?.throwIfAborted()
    return code
  } finally {
    if (escalation) clearTimeout(escalation)
    signal?.removeEventListener("abort", abort)
  }
}

let containerRunner: ContainerRunner = runCyberfulOsContainer

function stopCyberfulOsContainerSync(container: CyberfulOsContainer) {
  try {
    Bun.spawnSync([...container.command, "down"], {
      ...cyberfulOsContainerOptions(container),
      timeout: STOP_TIMEOUT_MS,
    })
  } catch (error) {
    log.warn("synchronous cyberful-os shutdown failed", { error: errorMessage(error) })
  }
}

async function stopCyberfulOsContainer(container: CyberfulOsContainer) {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new Error(`cyberful-os shutdown timed out after ${STOP_TIMEOUT_MS}ms`))
  }, STOP_TIMEOUT_MS)
  timeout.unref()
  try {
    const code = await containerRunner(container, "down", controller.signal)
    if (code !== 0) throw new Error(`cyberful-os shutdown exited with code ${code}`)
  } finally {
    clearTimeout(timeout)
  }
}

function stopStartedSync() {
  Array.from(cyberfulOsContainers.values(), (entry) => entry.container).forEach(stopCyberfulOsContainerSync)
}

function installDependencyExitHooks() {
  if (dependencyExitHooksInstalled) return
  dependencyExitHooksInstalled = true

  process.once("exit", stopStartedSync)
  if (process.env[CYBERFUL_PROCESS_ROLE] === "worker") return

  shutdownSignals.forEach((signal) => {
    process.once(signal, () => {
      dependencySignalShutdown ??= stopStarted()
        .catch((error) => {
          log.warn("cyberful-os signal shutdown failed", { error: errorMessage(error), signal })
        })
        .finally(() => {
          process.exit(signalExitCode(signal))
        })
    })
  })
}

function announce(bus: Bus.Interface, message: string) {
  return Effect.all(
    [
      Effect.sync(() => log.info(message)),
      bus
        .publish(TuiEvent.ToastShow, {
          title: "Cyberful startup",
          message,
          variant: "info",
          duration: 10_000,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.warn("failed to publish startup notice", { cause, message })),
          ),
        ),
    ],
    { discard: true },
  )
}

function errorValue(error: unknown) {
  return error instanceof Error ? error : new Error(errorMessage(error))
}

// ── One Process-Owned Start Exists Per Container Key ────────────
// Project instances may bootstrap concurrently but share the same configured
// cyberful-os container. The first caller registers a process-owned start task
// before spawning; later callers await that exact task instead of issuing another
// `up`. A failed start remains tracked when compensating `down` also fails, so
// shutdown can retry cleanup rather than losing a possible live container.
// ─────────────────────────────────────────────────────────────────
async function runOwnedStart(entry: Omit<CyberfulOsEntry, "task">, notices: StartupNotices) {
  try {
    await notices.announce("Starting the cybersecurity operating system...")
    const code = await containerRunner(entry.container, "up", entry.controller.signal)
    if (code !== 0) throw new Error(`cyberful-os startup exited with code ${code}`)
    if (entry.stopRequested) throw new Error("cyberful-os startup was cancelled by shutdown")
    entry.state = "started"
    await notices.announce("Cybersecurity operating system is ready.")
  } catch (startError) {
    entry.state = "failed"
    entry.failure = errorValue(startError)

    if (!entry.stopRequested) {
      try {
        await stopCyberfulOsContainer(entry.container)
        if (cyberfulOsContainers.get(entry.key) === entry) {
          cyberfulOsContainers.delete(entry.key)
          notifyLive()
        }
      } catch (cleanupError) {
        entry.failure = new AggregateError(
          [entry.failure, cleanupError],
          "cyberful-os startup failed and its container could not be cleaned up",
        )
      }
    }

    if (!entry.stopRequested) await notices.failure(entry.failure)
    throw entry.failure
  }
}

function claimCyberfulOsStart(
  container: CyberfulOsContainer,
  notices: StartupNotices,
  options: { installExitHooks: boolean },
) {
  const key = cyberfulOsContainerKey(container)
  if (stopping) return Promise.reject(new Error("cyberful-os shutdown is in progress"))
  const existing = cyberfulOsContainers.get(key)
  if (existing) {
    if (existing.state === "failed") {
      return Promise.reject(existing.failure ?? new Error("a failed cyberful-os container still requires cleanup"))
    }
    return existing.task
  }

  const owner = {
    container,
    controller: new AbortController(),
    key,
    state: "starting" as const,
    stopRequested: false,
  }
  const task = runOwnedStart(owner, notices)
  const entry = Object.assign(owner, { task })
  cyberfulOsContainers.set(key, entry)
  notifyLive()
  if (options.installExitHooks) installDependencyExitHooks()
  return task
}

const startCyberfulOs = Effect.fn("DependencyStartup.startCyberfulOs")(function* (bus: Bus.Interface) {
  if (!shouldStartCyberfulOs()) return

  const dir = cyberfulOsDir()
  if (!dir) return yield* Effect.fail(new Error("CYBERFUL_OS_DIR is not configured"))
  const directory = yield* Effect.tryPromise({
    try: () => stat(dir),
    catch: (error) => new Error(`failed to inspect CYBERFUL_OS_DIR: ${dir}`, { cause: error }),
  })
  if (!directory.isDirectory()) return yield* Effect.fail(new Error(`CYBERFUL_OS_DIR is not a directory: ${dir}`))

  const workspace = yield* InstanceState.directory
  const container = {
    command: cyberfulOsContainerCommand(),
    cwd: dir,
    env: { ...process.env, CYBERFUL_OS_WORKSPACE: envValue("CYBERFUL_OS_WORKSPACE") ?? workspace },
  }
  const notices = {
    announce: (message: string) => Effect.runPromise(announce(bus, message)),
    failure: (error: unknown) => Effect.runPromise(report("cyberful-os", bus)(error)),
  }
  yield* Effect.tryPromise({
    try: () => claimCyberfulOsStart(container, notices, { installExitHooks: true }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => log.debug("cyberful-os owner already reported startup failure", { error: errorMessage(error) })),
    ),
  )
})

function report(name: string, bus: Bus.Interface) {
  return (error: unknown) =>
    Effect.all(
      [
        Effect.sync(() => log.warn(`${name} startup failed`, { error: errorMessage(error) })),
        bus
          .publish(TuiEvent.ToastShow, {
            title: "Cyberful startup",
            message: `${name} startup failed: ${errorMessage(error)}`,
            variant: "warning",
            duration: 10_000,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.warn("failed to publish startup failure notice", { cause, name })),
            ),
          ),
      ],
      { discard: true },
    )
}

// ── Shutdown Is One Retryable Ownership Transition ──────────────
// Concurrent shutdown callers share one promise. It first cancels and reaps
// every in-flight start, then issues one bounded `down` for each still-owned
// container. Successfully reaped entries disappear immediately; failed entries
// remain owned so a later shutdown can retry rather than forgetting live state.
// ─────────────────────────────────────────────────────────────────
async function stopOwnedContainers() {
  stopping = true
  const failures: unknown[] = []
  try {
    const entries = [...cyberfulOsContainers.values()]
    for (const entry of entries) {
      entry.stopRequested = true
      if (entry.state === "starting") entry.controller.abort(new Error("cyberful-os process is shutting down"))
    }
    await Promise.allSettled(entries.map((entry) => entry.task))

    for (const entry of entries) {
      if (cyberfulOsContainers.get(entry.key) !== entry) continue
      try {
        await stopCyberfulOsContainer(entry.container)
        if (cyberfulOsContainers.get(entry.key) === entry) {
          cyberfulOsContainers.delete(entry.key)
          notifyLive()
        }
      } catch (error) {
        entry.state = "failed"
        entry.failure = errorValue(error)
        failures.push(error)
      }
    }
  } finally {
    stopping = false
  }
  if (failures.length > 0) throw new AggregateError(failures, "one or more cyberful-os dependencies failed to stop")
}

export function stopStarted() {
  if (stopInFlight) return stopInFlight
  const task = stopOwnedContainers()
  let wrapped: Promise<void>
  wrapped = task.finally(() => {
    if (stopInFlight === wrapped) stopInFlight = undefined
  })
  stopInFlight = wrapped
  return wrapped
}

export function onLiveChange(listener: (containers: string[]) => void) {
  liveListeners.add(listener)
  notifyListener(listener)
  return () => {
    liveListeners.delete(listener)
  }
}

function notifyLive() {
  const containers = liveContainers()
  for (const listener of liveListeners) notifyListener(listener, containers)
}

function liveContainers() {
  return [
    ...new Set(
      [...cyberfulOsContainers.values()].map((entry) => entry.container.env.CYBERFUL_OS_CONTAINER ?? "cyberful-os"),
    ),
  ]
}

function notifyListener(listener: (containers: string[]) => void, containers = liveContainers()) {
  try {
    listener([...containers])
  } catch (error) {
    log.warn("cyberful-os live listener failed", { error: errorMessage(error) })
  }
}

export const runCyberfulOs = Effect.gen(function* () {
  const bus = yield* Bus.Service
  yield* startCyberfulOs(bus).pipe(Effect.catch(report("cyberful-os", bus)))
})

export const run = runCyberfulOs

// Test boundary: replaces the external container command and clears process-owned
// state so lifecycle tests exercise concurrency without Docker or process hooks.
export function resetForTests(runner: ContainerRunner = runCyberfulOsContainer) {
  cyberfulOsContainers.clear()
  liveListeners.clear()
  containerRunner = runner
  stopInFlight = undefined
  stopping = false
}

export function startForTests(container: CyberfulOsContainer) {
  return claimCyberfulOsStart(
    container,
    {
      announce: async () => {},
      failure: async () => {},
    },
    { installExitHooks: false },
  )
}

export function liveCount() {
  return cyberfulOsContainers.size
}

export * as DependencyStartup from "./startup"
