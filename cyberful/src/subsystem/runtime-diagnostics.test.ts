// ── Runtime Diagnostics Tests ───────────────────────────────────
// Proves bounded local retention strips secrets, URL values, and terminal
// controls, keeps informational lifecycle noise out of operator alerts, and
// retains a final aggregate count for repeated failures.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RUNTIME_DIAGNOSTICS_PATH, RuntimeDiagnosticRecorder, sanitizeRuntimeDiagnostic } from "./runtime-diagnostics"

describe("runtime diagnostics", () => {
  test("sanitizes credentials, query values, and terminal sequences", () => {
    const result = sanitizeRuntimeDiagnostic(
      "\u001b[31mConnectionError https://user:pass@zap:8080/api?token=secret&mode=full Authorization: Bearer abc.def.ghi\u001b[0m",
    )
    expect(result).toContain("ConnectionError")
    expect(result).toContain("zap:8080")
    expect(result).not.toContain("user")
    expect(result).not.toContain("pass")
    expect(result).not.toContain("secret")
    expect(result).not.toContain("abc.def.ghi")
    expect(result).not.toContain("\u001b")
  })

  test("persists a deduplicated final count with first and last timestamps", async () => {
    const workarea = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-diagnostics-")))
    try {
      const recorder = new RuntimeDiagnosticRecorder({
        workarea,
        sessionID: "session-1",
        workflow: "bug-bounty",
        phase: "recon",
        attempt: 2,
      })
      const input = {
        component: "zap" as const,
        profile: "phase-gateway",
        stage: "connect" as const,
        severity: "error" as const,
        errorClass: "ConnectionError",
        code: "ECONNREFUSED",
        message: "http://zap:8080 ConnectionError cookie=session-secret",
      }
      recorder.record(input)
      recorder.record(input)
      await recorder.close()

      const rows = (await readFile(path.join(workarea, RUNTIME_DIAGNOSTICS_PATH), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(rows.at(-1)).toMatchObject({
        version: 2,
        component: "zap",
        phase: "recon",
        attempt: 2,
        errorClass: "ConnectionError",
        outcome: "runtime_failure",
        blocking: false,
        count: 2,
      })
      expect(rows.at(-1).message).not.toContain("session-secret")
      expect(rows.at(-1).firstTimestamp).toBeString()
      expect(rows.at(-1).lastTimestamp).toBeString()
      expect(rows.at(-1).signature).toMatch(/^[a-f0-9]{64}$/)
      expect(rows.at(-1).messageSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(rows.at(-1).originalBytes).toBeGreaterThan(0)
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("keeps informational lifecycle records local without notifying the operator", async () => {
    const workarea = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-diagnostics-info-")))
    const notifications: unknown[] = []
    try {
      const recorder = new RuntimeDiagnosticRecorder({
        workarea,
        sessionID: "session-1",
        workflow: "pentest",
        phase: "brief",
        attempt: 1,
        onFirst: (summary) => notifications.push(summary),
      })
      recorder.record({
        component: "browser",
        profile: "expert-gateway",
        stage: "startup",
        severity: "info",
        errorClass: "GatewayLifecycle",
        message: "[browser] stdio server started",
      })
      recorder.record({
        component: "browser",
        profile: "expert-gateway",
        stage: "connect",
        severity: "warning",
        errorClass: "ConnectionError",
        message: "browser connection refused",
      })
      await recorder.close()

      const rows = (await readFile(path.join(workarea, RUNTIME_DIAGNOSTICS_PATH), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(rows.map((row) => row.severity)).toEqual(["info", "warning"])
      expect(notifications).toEqual([
        {
          component: "browser",
          profile: "expert-gateway",
          stage: "connect",
          severity: "warning",
          errorClass: "ConnectionError",
          message: "browser connection refused",
          path: RUNTIME_DIAGNOSTICS_PATH,
        },
      ])
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("keeps every serialized record within the eight KiB boundary", async () => {
    const workarea = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-diagnostics-bound-")))
    try {
      const recorder = new RuntimeDiagnosticRecorder({
        workarea,
        sessionID: "session-1",
        workflow: "pentest",
        phase: "exploit",
        attempt: 1,
      })
      recorder.record({
        component: "browser",
        profile: "profile".repeat(1_000),
        stage: "startup",
        severity: "error",
        errorClass: "BrowserStartupFailure".repeat(1_000),
        code: "E".repeat(1_000),
        message: "connection refused ".repeat(2_000),
      })
      await recorder.close()

      const line = (await readFile(path.join(workarea, RUNTIME_DIAGNOSTICS_PATH), "utf8")).trimEnd()
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(8 * 1024)
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })
})
