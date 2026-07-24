// ── TUI Terminal Resource Cleanup ────────────────────────────────
// Reaps worker-owned process trees and Docker resources after the control-plane
//   worker exits or exceeds its shutdown deadline.
// → cyberful/src/cli/cmd/tui/thread.ts — invokes this terminal-owned fallback.
// → cyberful/src/subsystem/container.ts — performs the awaited run-label sweep.
// ─────────────────────────────────────────────────────────────────

import { SubsystemCli } from "@/subsystem/cli"
import { SubsystemContainer } from "@/subsystem/container"
import { errorMessage } from "@/util/error"
import * as Log from "@/util/log"
import type { DockerResource } from "./rpc-contract"

const DOCKER_EXIT_CLEANUP_TIMEOUT_MS = 5_000
const DOCKER_EXIT_CLEANUP_OUTPUT_BYTES = 64 * 1024

type CleanupAfterWorkerInput = {
  runID: string
  pids: Iterable<number>
  resources: Iterable<DockerResource>
}

export type CleanupAfterWorkerDeps = {
  info: (message: string) => void
  killTree: (pid: number) => void
  removeRunOwned: (runID: string) => Promise<void>
  reapSnapshotSync: (resources: Iterable<DockerResource>) => boolean
  reapRunOwnedSync: (runID: string) => boolean
  warn: (message: string, error: unknown) => void
}

function dockerCleanupSync(argv: string[], resource: DockerResource): boolean {
  try {
    const result = Bun.spawnSync(["docker", ...argv], {
      stdout: "ignore",
      stderr: "pipe",
      timeout: DOCKER_EXIT_CLEANUP_TIMEOUT_MS,
      maxBuffer: DOCKER_EXIT_CLEANUP_OUTPUT_BYTES,
    })
    const stderr = new TextDecoder().decode(result.stderr).trim()
    if (result.exitCode === 0 || stderr.includes("No such container")) return true
    Log.Default.warn("failed to reap TUI Docker resource", {
      resource: resource.name,
      action: resource.action,
      kind: resource.kind,
      exitCode: result.exitCode,
      error: stderr || "Docker cleanup command did not complete successfully",
    })
  } catch (error) {
    Log.Default.warn("failed to reap TUI Docker resource", {
      error,
      resource: resource.name,
      action: resource.action,
      kind: resource.kind,
    })
  }
  return false
}

export function reapDockerResourcesSync(resources: Iterable<DockerResource>): boolean {
  let succeeded = true
  for (const resource of resources) {
    if (resource.kind === "zap" || resource.kind === "ghidra") {
      const relationLabel =
        resource.kind === "zap" ? "org.cyberful.zap-container" : "org.cyberful.ghidra-container"
      try {
        const related = Bun.spawnSync(
          ["docker", "ps", "--all", "--quiet", "--filter", `label=${relationLabel}=${resource.name}`],
          {
            stdout: "pipe",
            stderr: "pipe",
            timeout: DOCKER_EXIT_CLEANUP_TIMEOUT_MS,
            maxBuffer: DOCKER_EXIT_CLEANUP_OUTPUT_BYTES,
          },
        )
        const stderr = new TextDecoder().decode(related.stderr).trim()
        if (related.exitCode !== 0) {
          succeeded = false
          Log.Default.warn("failed to list TUI related Docker resources", {
            resource: resource.name,
            exitCode: related.exitCode,
            error: stderr || "Docker resource listing did not complete successfully",
          })
        } else {
          new TextDecoder()
            .decode(related.stdout)
            .trim()
            .split("\n")
            .filter(Boolean)
            .forEach((container) => {
              succeeded =
                dockerCleanupSync(["rm", "--force", "--volumes", container], {
                  name: container,
                  action: "remove",
                  kind: resource.kind,
                }) && succeeded
            })
        }
      } catch (error) {
        succeeded = false
        Log.Default.warn("failed to list TUI related Docker resources", { error, resource: resource.name })
      }
    }

    succeeded =
      dockerCleanupSync(
        resource.action === "remove"
          ? ["rm", "--force", "--volumes", resource.name]
          : ["stop", "--time", "1", resource.name],
        resource,
      ) && succeeded
  }
  return succeeded
}

// ── Run Labels Recover Containers Missing From RPC Inventory ────────────
// A gateway can dispatch `docker run` immediately before it is killed, allowing
// the daemon to create a container after the worker's last live snapshot. The
// terminal process queries the immutable run labels, keeping this fallback
// isolated from concurrent Cyberful runs even when the snapshot is stale.
// ────────────────────────────────────────────────────────────────
export function reapRunOwnedDockerResourcesSync(runID: string): boolean {
  const filters = SubsystemContainer.ownerFilterArguments(runID)
  if (filters.length === 0) return true
  try {
    const listed = Bun.spawnSync(["docker", "ps", "--all", "--quiet", ...filters], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: DOCKER_EXIT_CLEANUP_TIMEOUT_MS,
      maxBuffer: DOCKER_EXIT_CLEANUP_OUTPUT_BYTES,
    })
    const stderr = new TextDecoder().decode(listed.stderr).trim()
    if (listed.exitCode !== 0) {
      Log.Default.warn("failed to list TUI run-owned Docker resources", {
        exitCode: listed.exitCode,
        error: stderr || "Docker resource listing did not complete successfully",
      })
      return false
    }
    const resources = new TextDecoder()
      .decode(listed.stdout)
      .trim()
      .split("\n")
      .filter((id) => /^[a-f0-9]{12,64}$/i.test(id))
      .map((name): DockerResource => ({ name, action: "remove", kind: "expert" }))
    return reapDockerResourcesSync(resources)
  } catch (error) {
    Log.Default.warn("failed to reap TUI run-owned Docker resources", { error })
    return false
  }
}

const defaultCleanupAfterWorkerDeps: CleanupAfterWorkerDeps = {
  info: (message) => Log.Default.info(message),
  killTree: (pid) => SubsystemCli.killTree(pid, "SIGKILL"),
  removeRunOwned: (runID) => SubsystemContainer.removeForShutdown(runID),
  reapSnapshotSync: reapDockerResourcesSync,
  reapRunOwnedSync: reapRunOwnedDockerResourcesSync,
  warn: (message, error) => Log.Default.warn(message, { error: errorMessage(error) }),
}

// ── Worker Timeout Does Not Shorten Docker Cleanup ───────────────
// A worker can spend its entire shutdown allowance unwinding an active phase.
// Once the terminal terminates that worker, Docker still needs its independent
// bounded removal window; the five-second synchronous process-exit hook is only
// a final retry. Awaiting the label sweep here prevents a slow Docker Desktop
// daemon from turning a handled TUI close into a silent engagement-container leak.
// ─────────────────────────────────────────────────────────────────
export async function cleanupAfterWorker(
  input: CleanupAfterWorkerInput,
  deps: CleanupAfterWorkerDeps = defaultCleanupAfterWorkerDeps,
) {
  deps.info("terminal container cleanup started")
  const resources = [...input.resources]
  for (const pid of input.pids) deps.killTree(pid)
  let awaitedFailure: unknown
  await deps.removeRunOwned(input.runID).catch((error) => {
    awaitedFailure = error
  })
  const snapshotSucceeded = deps.reapSnapshotSync(resources)
  const sweepSucceeded = deps.reapRunOwnedSync(input.runID)
  if (awaitedFailure || !snapshotSucceeded || !sweepSucceeded) {
    deps.warn(
      "terminal container cleanup failed",
      awaitedFailure ?? new Error("one or more synchronous cleanup attempts failed"),
    )
  } else {
    deps.info("terminal container cleanup completed")
  }
}
