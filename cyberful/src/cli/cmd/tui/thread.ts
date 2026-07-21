// ── TUI Worker Process Lifecycle ─────────────────────────────────
// Launches the isolated control-plane worker, bridges RPC and global events,
//   coordinates dependency preflight, and reaps worker and container resources
//   on normal exit, signal, startup failure, or forced shutdown.
// → cyberful/src/cli/cmd/tui/worker.ts — owns worker-side services and ordered shutdown.
// ─────────────────────────────────────────────────────────────────

import { cmd } from "@/cli/cmd/cmd"
import { Rpc } from "@/util/rpc"
import { SubsystemCli } from "@/subsystem/cli"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { UI } from "@/cli/ui"
import * as Log from "@/util/log"
import { errorMessage } from "@/util/error"
import { observePromise } from "@/util/promise"
import { withTimeout } from "@/util/timeout"
import { withNetworkOptions, resolveNetworkOptionsNoConfig } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import type { EventSource } from "./context/sdk"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { writeHeapSnapshot } from "node:v8"
import { TuiConfig } from "./config/tui"
import { DockerPreflight } from "@/dependency/docker-preflight"
import { SubsystemCodex } from "@/subsystem/codex"
import { BrowserPreflight } from "@/dependency/browser-preflight"
import { CYBERFUL_PROCESS_ROLE, CYBERFUL_RUN_ID, ensureRunID, sanitizedProcessEnv } from "@/util/cyberful-process"
import { validateSession } from "./validate-session"
import { TuiRpcContract, type DockerResource } from "./rpc-contract"
import { SubsystemContainer } from "@/subsystem/container"

declare global {
  const CYBERFUL_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof TuiRpcContract>>
const shutdownSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
const WORKER_SHUTDOWN_TIMEOUT_MS = 15_000
const DOCKER_EXIT_CLEANUP_TIMEOUT_MS = 5_000
const DOCKER_EXIT_CLEANUP_OUTPUT_BYTES = 64 * 1024

function signalExitCode(signal: (typeof shutdownSignals)[number]) {
  if (signal === "SIGHUP") return 129
  if (signal === "SIGINT") return 130
  return 143
}

function reapDockerResourcesSync(resources: Iterable<DockerResource>) {
  for (const resource of resources) {
    try {
      if (resource.kind === "zap") {
        const related = Bun.spawnSync(
          ["docker", "ps", "--all", "--quiet", "--filter", `label=org.cyberful.zap-container=${resource.name}`],
          {
            stdout: "pipe",
            stderr: "ignore",
            timeout: DOCKER_EXIT_CLEANUP_TIMEOUT_MS,
            maxBuffer: DOCKER_EXIT_CLEANUP_OUTPUT_BYTES,
          },
        )
        if (related.exitCode === 0) {
          new TextDecoder()
            .decode(related.stdout)
            .trim()
            .split("\n")
            .filter(Boolean)
            .forEach((container) => {
              Bun.spawnSync(["docker", "rm", "--force", "--volumes", container], {
                stdout: "ignore",
                stderr: "ignore",
                timeout: DOCKER_EXIT_CLEANUP_TIMEOUT_MS,
              })
            })
        }
      }

      Bun.spawnSync(
        resource.action === "remove"
          ? ["docker", "rm", "--force", "--volumes", resource.name]
          : ["docker", "stop", "--time", "1", resource.name],
        { stdout: "ignore", stderr: "ignore", timeout: DOCKER_EXIT_CLEANUP_TIMEOUT_MS },
      )
    } catch (error) {
      Log.Default.warn("failed to reap TUI Docker resource", {
        error,
        resource: resource.name,
        action: resource.action,
      })
    }
  }
}

// ── Run Labels Recover Containers Missing From RPC Inventory ────────────
// A gateway can dispatch `docker run` immediately before it is killed, allowing
// the daemon to create a container after the worker's last live snapshot. The
// terminal process waits for worker termination and then queries the immutable
// run labels, keeping this fallback isolated from concurrent Cyberful runs.
// ────────────────────────────────────────────────────────────────
function reapRunOwnedDockerResourcesSync(runID: string) {
  const filters = SubsystemContainer.ownerFilterArguments(runID)
  if (filters.length === 0) return
  try {
    const listed = Bun.spawnSync(["docker", "ps", "--all", "--quiet", ...filters], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: DOCKER_EXIT_CLEANUP_TIMEOUT_MS,
      maxBuffer: DOCKER_EXIT_CLEANUP_OUTPUT_BYTES,
    })
    if (listed.exitCode !== 0) {
      Log.Default.warn("failed to list TUI run-owned Docker resources")
      return
    }
    const resources = new TextDecoder()
      .decode(listed.stdout)
      .trim()
      .split("\n")
      .filter((id) => /^[a-f0-9]{12,64}$/i.test(id))
      .map((name): DockerResource => ({ name, action: "remove", kind: "expert" }))
    reapDockerResourcesSync(resources)
  } catch (error) {
    Log.Default.warn("failed to reap TUI run-owned Docker resources", { error })
  }
}

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return Object.assign(fn, { preconnect: fetch.preconnect })
}

function createEventSource(client: RpcClient): EventSource {
  return {
    subscribe: async (handler) => {
      return client.on("global.event", (e) => {
        handler(e)
      })
    },
  }
}

async function target() {
  if (typeof CYBERFUL_WORKER_PATH !== "undefined") return CYBERFUL_WORKER_PATH
  const dist = new URL("./cli/cmd/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("./worker.ts", import.meta.url)
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return Filesystem.resolve(cwd)
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start cyberful tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start cyberful in",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("workarea", {
        type: "string",
        describe: "store engagement artifacts under work/<workarea>/",
      }),
  handler: async (args) => {
    // Keep ENABLE_PROCESSED_INPUT cleared even if other code flips it.
    // (Important when running under `bun run` wrappers on Windows.)
    const unguard = win32InstallCtrlCGuard()
    try {
      // Must be the very first thing — disables CTRL_C_EVENT before any Worker
      // spawn or async work so the OS cannot kill the process group.
      win32DisableProcessedInput()

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
      const next = resolveThreadDirectory(args.project)
      const file = await target()
      try {
        process.chdir(next)
      } catch {
        UI.error("Failed to change directory to " + next)
        return
      }
      // ── Preflight Completes Before The Worker Owns The Terminal ──────
      // Codex is mandatory and inexpensive to verify, so authentication failure
      // stops before the slower Docker preparation begins. Docker readiness is
      // blocking because session creation depends on it; browser preparation is
      // best-effort but still completes before the worker takes the terminal.
      // The verified Codex descriptor then crosses as worker-owned environment.
      // ────────────────────────────────────────────────────────────────
      const codexSubsystem = await SubsystemCodex.preflight()

      const cwd = Filesystem.resolve(process.cwd())
      const runID = ensureRunID()
      const env = sanitizedProcessEnv({
        [CYBERFUL_PROCESS_ROLE]: "worker",
        [CYBERFUL_RUN_ID]: runID,
        ...SubsystemCodex.workerEnv(codexSubsystem),
      })

      await DockerPreflight.runDockerPreflight()

      await BrowserPreflight.runBrowserPreflight()

      const worker = new Worker(file, {
        env,
      })
      const client = Rpc.client(worker, TuiRpcContract)
      worker.onerror = (e) => {
        client.close(new Error(`TUI worker failed: ${e.message}`, { cause: e.error }))
        Log.Default.error("thread error", {
          message: e.message,
          filename: e.filename,
          lineno: e.lineno,
          colno: e.colno,
          error: e.error,
        })
      }

      // ── Terminal Owns Emergency Reaping After Worker Failure ───
      // Normal shutdown asks the worker to stop resources in dependency order.
      // Complete live snapshots also let this process kill detached descendants
      // when the worker cannot answer that request. Closing the RPC subscription
      // freezes the final inventory before the fallback reaper consumes it.
      // ─────────────────────────────────────────────────────────────────
      const liveSubsystemPids = new Set<number>()
      client.on("subsystem.live", ({ pids }) => {
        liveSubsystemPids.clear()
        for (const pid of pids) liveSubsystemPids.add(pid)
      })
      const liveDockerResources = new Map<string, DockerResource>()
      client.on("docker.live", ({ resources }) => {
        liveDockerResources.clear()
        for (const resource of resources) liveDockerResources.set(`${resource.action}\0${resource.name}`, resource)
      })
      process.once("exit", () => {
        for (const pid of liveSubsystemPids) SubsystemCli.killTree(pid, "SIGKILL")
        reapDockerResourcesSync(liveDockerResources.values())
        reapRunOwnedDockerResourcesSync(runID)
      })

      const error = (e: unknown) => {
        Log.Default.error("process error", { error: errorMessage(e) })
      }
      const reload = () => {
        observePromise(client.call("reload", undefined), {
          rejected: (error) => {
            Log.Default.warn("worker reload failed", {
              error: errorMessage(error),
            })
          },
        })
      }
      process.on("uncaughtException", error)
      process.on("unhandledRejection", error)
      process.on("SIGUSR2", reload)

      let stopped = false
      let signalShutdown: Promise<void> | undefined
      let removeSignalHandlers = () => {}
      const stop = async () => {
        if (stopped) return
        stopped = true
        removeSignalHandlers()
        process.off("uncaughtException", error)
        process.off("unhandledRejection", error)
        process.off("SIGUSR2", reload)
        await withTimeout(client.call("shutdown", undefined), WORKER_SHUTDOWN_TIMEOUT_MS).catch((error) => {
          Log.Default.warn("worker shutdown failed", {
            error: errorMessage(error),
          })
        })
        client.close()
        await worker.terminate()
        for (const pid of liveSubsystemPids) SubsystemCli.killTree(pid, "SIGKILL")
        reapDockerResourcesSync(liveDockerResources.values())
        reapRunOwnedDockerResourcesSync(runID)
        liveSubsystemPids.clear()
        liveDockerResources.clear()
      }
      const signalCleanups = shutdownSignals.map((signal) => {
        const handler = () => {
          signalShutdown ??= stop().finally(() => process.exit(signalExitCode(signal)))
        }
        process.once(signal, handler)
        return () => process.off(signal, handler)
      })
      removeSignalHandlers = () => signalCleanups.forEach((cleanup) => cleanup())

      try {
        const prompt = await input(args.prompt)
        const config = await TuiConfig.get()

        const network = resolveNetworkOptionsNoConfig(args)
        const external = process.argv.includes("--port") || network.port !== 0

        const transport = external
          ? {
              url: (await client.call("server", network)).url,
              fetch: undefined,
              events: undefined,
            }
          : {
              url: "http://cyberful.internal",
              fetch: createWorkerFetch(client),
              events: createEventSource(client),
            }

        try {
          await validateSession({
            url: transport.url,
            sessionID: args.session,
            directory: cwd,
            fetch: transport.fetch,
          })
        } catch (error) {
          UI.error(errorMessage(error))
          process.exitCode = 1
          return
        }

        const { tui } = await import("./app")
        await tui({
          url: transport.url,
          async onSnapshot() {
            const tui = writeHeapSnapshot("tui.heapsnapshot")
            const server = await client.call("snapshot", undefined)
            return [tui, server]
          },
          config,
          directory: cwd,
          fetch: transport.fetch,
          events: transport.events,
          args: {
            continue: args.continue,
            sessionID: args.session,
            agent: args.agent,
            workarea: args.workarea,
            prompt,
            fork: args.fork,
          },
        })
      } finally {
        await stop()
      }
    } finally {
      unguard?.()
    }
    process.exit(0)
  },
})
