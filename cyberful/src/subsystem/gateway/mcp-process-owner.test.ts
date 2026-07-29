// ── Gateway MCP Process Ownership Tests ──────────────────────────
// Proves descendant selection, PID-reuse resistance, and bounded TERM/KILL
//   fallback without signaling a sibling run.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import {
  ownedProcessTree,
  reapCapturedProcessTree,
  type OwnedProcessIdentity,
} from "./mcp-process-owner"

const identity = (pid: number, ppid: number, command: string, started = `start-${pid}`): OwnedProcessIdentity => ({
  pid,
  ppid,
  started,
  command,
})

describe("gateway MCP process ownership", () => {
  test("captures only registered roots and their descendants", () => {
    const snapshot = [
      identity(100, 10, "gateway-a-mcp"),
      identity(101, 100, "gateway-a-child"),
      identity(102, 101, "gateway-a-grandchild"),
      identity(200, 10, "concurrent-gateway-mcp"),
      identity(201, 200, "concurrent-child"),
    ]
    expect(ownedProcessTree(snapshot, [100]).map((entry) => entry.pid)).toEqual([100, 101, 102])
  })

  test("records survivors before fallback and never signals a recycled PID or sibling", async () => {
    const root = identity(100, 10, "owned-root")
    const child = identity(101, 100, "owned-child")
    const sibling = identity(200, 10, "other-run")
    const recycled = identity(100, 1, "new-unrelated-process", "later-start")
    const snapshots = [
      [recycled, child, sibling],
      [recycled, child, sibling],
      [recycled, sibling],
    ]
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const order: string[] = []
    const result = await reapCapturedProcessTree([root, child], {
      snapshot: async () => snapshots.shift() ?? [recycled, sibling],
      signal: (pid, signal) => {
        signals.push({ pid, signal })
        order.push(`signal:${signal}`)
      },
      wait: async () => {},
      onSurvivors: (processes) => {
        order.push(`evidence:${processes.map((process) => process.pid).join(",")}`)
      },
    })

    expect(result.survivedClose.map((entry) => entry.pid)).toEqual([101])
    expect(result.forceKilled.map((entry) => entry.pid)).toEqual([101])
    expect(result.remaining).toEqual([])
    expect(signals).toEqual([
      { pid: 101, signal: "SIGTERM" },
      { pid: 101, signal: "SIGKILL" },
    ])
    expect(order).toEqual(["evidence:101", "signal:SIGTERM", "signal:SIGKILL"])
  })
})
