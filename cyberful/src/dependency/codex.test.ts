// ── Codex Probe Boundary Tests ──────────────────────────────────
// Exercises malformed, timed-out, and excessive subprocess output without an
//   installed Codex CLI or leaked probe output in the test terminal.
// → cyberful/src/dependency/codex.ts — owns the bounded probe contract.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { codexVersion } from "./codex"

function nodeProbe(source: string, timeoutMs = 1_000) {
  return codexVersion({
    executable: process.execPath,
    prefixArguments: ["-e", source, "--"],
    timeoutMs,
  })
}

describe("Codex compatibility probe", () => {
  test("rejects output that does not prove a Codex CLI version", async () => {
    await expect(nodeProbe('process.stdout.write("not-a-codex-version")')).rejects.toThrow(
      "Codex version output did not match",
    )
  })

  test("times out and reaps a silent probe", async () => {
    await expect(nodeProbe("setInterval(() => {}, 1_000)", 25)).rejects.toThrow("Codex probe timed out after 25ms")
  })

  test("terminates a probe that exceeds its output budget", async () => {
    await expect(nodeProbe('process.stdout.write("x".repeat(70 * 1024))')).rejects.toThrow(
      "Failed to execute Codex probe",
    )
  })
})
