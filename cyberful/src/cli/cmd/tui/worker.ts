// ── TUI Control-Plane Worker ─────────────────────────────────────
// Boots the worker-owned application runtime and RPC server, forwards global
//   events, and disposes phase processes, gateways, instances, and dependencies
//   before the worker exits.
// → cyberful/src/cli/cmd/tui/thread.ts — launches the worker and owns emergency reaping.
// ─────────────────────────────────────────────────────────────────

import { InstallationLocal } from "@/installation/version"
import { Server } from "@/server/server"
import * as Log from "@/util/log"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { ensureProcessMetadata } from "@/util/cyberful-process"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { DependencyStartup } from "@/dependency/startup"
import { SubsystemCli } from "@/subsystem/cli"
import { SubsystemContainer } from "@/subsystem/container"
import { SubsystemZapRuntime } from "@/subsystem/zap/runtime"
import { SubsystemAskRuntime } from "@/subsystem/ask-runtime"
import { decodeTuiGlobalEvent, TuiRpcContract } from "./rpc-contract"

ensureProcessMetadata("worker")

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: InstallationLocal,
  level: (() => {
    if (InstallationLocal) return "DEBUG"
    return "INFO"
  })(),
})

Heap.start()

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

GlobalBus.on("event", (event) => {
  Rpc.emit(TuiRpcContract, "global.event", decodeTuiGlobalEvent(event))
})

// ── Main Process Retains A Last-Resort Resource Inventory ────────
// Cooperative shutdown remains worker-owned because it can order each runtime.
// Detached process groups and containers are also mirrored to the terminal
// process, which can reap that last known inventory if this worker wedges.
// Updates replace complete snapshots so stale ownership is never accumulated.
// ─────────────────────────────────────────────────────────────────
SubsystemCli.onLiveChange((pids) => {
  Rpc.emit(TuiRpcContract, "subsystem.live", { pids })
})

let expertContainers: string[] = []
let zapContainers: string[] = []
let dependencyContainers: string[] = []
const emitContainers = () =>
  Rpc.emit(TuiRpcContract, "docker.live", {
    resources: [
      ...expertContainers.map((name) => ({ name, action: "remove" as const, kind: "expert" as const })),
      ...zapContainers.map((name) => ({ name, action: "remove" as const, kind: "zap" as const })),
      ...dependencyContainers.map((name) => ({ name, action: "stop" as const, kind: "dependency" as const })),
    ],
  })
const stopExpertContainerLiveUpdates = SubsystemContainer.onLiveChange((containers) => {
  expertContainers = containers
  emitContainers()
})
SubsystemZapRuntime.onLiveChange((containers) => {
  zapContainers = containers
  emitContainers()
})
const stopDependencyLiveUpdates = DependencyStartup.onLiveChange((containers) => {
  dependencyContainers = containers
  emitContainers()
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

const handlers = {
  async fetch(input) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async reload() {
    await SubsystemAskRuntime.stopAll()
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    Log.Default.info("worker shutting down")

    // Stop accepting external requests before tearing down their instance state. The in-process RPC
    // carrying this shutdown is independent from this listener.
    if (server) {
      await server.stop(true).catch((error) => {
        Log.Default.warn("server shutdown failed", {
          error: error instanceof Error ? error.message : error,
        })
      })
      server = undefined
    }

    // ── Raw Phase Processes Exit Before Instance Fibers ───────────
    // Phase subprocesses and gateway descendants are spawned outside the Effect
    // scope that awaits them. Interrupting the fiber alone would leave OS owners
    // alive while later teardown removes their dependencies. Reaping that tree
    // first resolves the wait and makes the remaining instance cleanup safe.
    // ─────────────────────────────────────────────────────────────────
    await SubsystemCli.killAll().catch((error) => {
      Log.Default.warn("expert subprocess shutdown failed", {
        error: error instanceof Error ? error.message : error,
      })
    })

    // ── Instance Disposal Closes The Late-Spawn Window ────────────
    // The first process sweep also latches the subsystem against new owners.
    // Instance disposal then interrupts producers before container registries
    // are consumed, preventing work from appearing behind a completed snapshot.
    // A second process sweep observes anything that raced the first inventory
    // and proves the registry empty before dependency teardown proceeds.
    // ───────────────────────────────────────────────────────────────
    await InstanceRuntime.disposeAllInstances().catch((error) => {
      Log.Default.warn("instance shutdown failed", {
        error: error instanceof Error ? error.message : error,
      })
    })

    await SubsystemCli.killAll().catch((error) => {
      Log.Default.warn("late expert subprocess shutdown failed", {
        error: error instanceof Error ? error.message : error,
      })
    })

    await SubsystemAskRuntime.stopAll().catch((error) => {
      Log.Default.warn("Ask runtime shutdown failed", {
        error: error instanceof Error ? error.message : error,
      })
    })

    await Promise.all([
      SubsystemZapRuntime.removeAll().catch((error) => {
        Log.Default.warn("ZAP container shutdown failed", {
          error: error instanceof Error ? error.message : error,
        })
      }),
      SubsystemContainer.removeAll().catch((error) => {
        Log.Default.warn("expert container shutdown failed", {
          error: error instanceof Error ? error.message : error,
        })
      }),
      DependencyStartup.stopStarted().catch((error) => {
        Log.Default.warn("dependency shutdown failed", {
          error: error instanceof Error ? error.message : error,
        })
      }),
    ])
    stopDependencyLiveUpdates()
    stopExpertContainerLiveUpdates()

    await AppRuntime.dispose().catch((error) => {
      Log.Default.warn("app runtime shutdown failed", {
        error: error instanceof Error ? error.message : error,
      })
    })
    await Log.dispose()
  },
} satisfies Rpc.Definition<typeof TuiRpcContract>

Rpc.listen(TuiRpcContract, handlers)
