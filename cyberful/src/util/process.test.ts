// ── Subprocess Boundary Tests ────────────────────────────────────
// Protects normal command capture and the output ceiling that prevents a local
// helper from exhausting Cyberful's memory during everyday use.
// → cyberful/src/util/process.ts — implements the subprocess contract under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { Process } from "./process"

describe("subprocess boundary", () => {
  test("captures ordinary stdout and stderr without a shell", async () => {
    const result = await Process.run([
      process.execPath,
      "-e",
      'process.stdout.write("ready"); process.stderr.write("diagnostic")',
    ])
    expect(result.code).toBe(0)
    expect(result.stdout.toString()).toBe("ready")
    expect(result.stderr.toString()).toBe("diagnostic")
  })

  test("terminates output that exceeds the caller's memory budget", async () => {
    await expect(
      Process.run([process.execPath, "-e", 'process.stdout.write("x".repeat(4096))'], { maxOutputBytes: 128 }),
    ).rejects.toThrow("Process output exceeded 128 bytes")
  })
})
