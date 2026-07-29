// ── Gateway MCP Process Ownership Integration Test ───────────────
// Exercises the production process inventory and signal path against a real
//   parent/child tree without depending on an SDK mock.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import {
  ownedProcessTree,
  processSnapshot,
  reapCapturedProcessTree,
  type OwnedProcessIdentity,
} from "./mcp-process-owner"

test.skipIf(process.platform === "win32")("reaps a real owned process tree back to baseline", async () => {
  const root = Bun.spawn(["sh", "-c", "sleep 30 & wait"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  try {
    let captured: readonly OwnedProcessIdentity[] = []
    for (let attempt = 0; attempt < 50; attempt++) {
      captured = ownedProcessTree(await processSnapshot(), [root.pid])
      if (captured.length >= 2) break
      await Bun.sleep(20)
    }
    expect(captured.some((entry) => entry.pid === root.pid)).toBe(true)
    expect(captured.length).toBeGreaterThanOrEqual(2)

    const cleanup = await reapCapturedProcessTree(captured)
    expect(cleanup.survivedClose.length).toBe(captured.length)
    expect(cleanup.remaining).toEqual([])
    const current = await processSnapshot()
    expect(ownedProcessTree(current, [root.pid])).toEqual([])
  } finally {
    try {
      root.kill("SIGKILL")
    } catch {}
    await root.exited
  }
})
