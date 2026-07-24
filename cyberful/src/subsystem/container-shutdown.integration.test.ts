// ── Live Docker Shutdown Ownership Contract ─────────────────────
// Creates run-labelled disposable containers and proves normal cleanup, the
//   post-worker timeout path, and the synchronous crash fallback leave none.
// → cyberful/src/subsystem/container.ts — owns asynchronous run-label removal.
// → cyberful/src/cli/cmd/tui/thread-cleanup.ts — owns terminal fallback removal.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { cleanupAfterWorker, reapRunOwnedDockerResourcesSync } from "@/cli/cmd/tui/thread-cleanup"
import { dockerOwnershipLabels, RUN_OWNER_LABEL, runOwnerToken } from "@/util/container-ownership"
import { SubsystemContainer } from "./container"

const IMAGE = "cyberful-os:latest"
const DOCKER_TIMEOUT_MS = 30_000

async function docker(argv: string[], allowMissing = false): Promise<string> {
  const proc = Bun.spawn(["docker", ...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: DOCKER_TIMEOUT_MS,
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0 && !(allowMissing && stderr.includes("No such container"))) {
    throw new Error(`docker ${argv[0] ?? "command"} failed with ${code}: ${stderr.trim()}`)
  }
  return stdout.trim()
}

async function createOwnedContainer(name: string, runID: string, runtime: string) {
  const labels = dockerOwnershipLabels({
    managed: runtime,
    runtime,
    session: "shutdown-integration",
    runID,
  }).flatMap((label) => ["--label", label])
  await docker([
    "run",
    "--detach",
    "--name",
    name,
    ...labels,
    "--entrypoint",
    "sleep",
    IMAGE,
    "300",
  ])
}

async function ownedContainers(runID: string) {
  const owner = runOwnerToken(runID)
  if (!owner) throw new Error("run owner token was not derived")
  const output = await docker(["ps", "--all", "--quiet", "--filter", `label=${RUN_OWNER_LABEL}=${owner}`])
  return output ? output.split("\n") : []
}

test(
  "normal, timed-out worker, and crash fallback leave zero run-owned containers",
  async () => {
    SubsystemContainer.resetTestDoubles()
    const runID = `shutdown-${randomUUID()}`
    const suffix = runOwnerToken(runID)?.slice(0, 12)
    if (!suffix) throw new Error("run owner suffix was not derived")
    const names = ["normal", "timeout", "crash"].map((mode) => `cyberful-test-${mode}-${suffix}`)

    try {
      await createOwnedContainer(names[0]!, runID, "normal")
      await SubsystemContainer.removeOwned(runID)
      expect(await ownedContainers(runID)).toEqual([])

      await createOwnedContainer(names[1]!, runID, "worker-timeout")
      await cleanupAfterWorker({ runID, pids: [], resources: [] })
      expect(await ownedContainers(runID)).toEqual([])

      await createOwnedContainer(names[2]!, runID, "worker-crash")
      expect(reapRunOwnedDockerResourcesSync(runID)).toBe(true)
      expect(await ownedContainers(runID)).toEqual([])
    } finally {
      await Promise.all(names.map((name) => docker(["rm", "--force", "--volumes", name], true)))
      SubsystemContainer.resetTestDoubles()
    }
  },
  120_000,
)
