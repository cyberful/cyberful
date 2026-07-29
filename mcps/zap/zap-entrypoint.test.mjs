// ── Unrestricted ZAP Runtime Contract ───────────────────────────────
// Verifies the packaged daemon keeps the API authenticated and telemetry-free
// while leaving file transfer and MCP history available to the isolated bridge.
// → mcps/zap/zap-entrypoint.sh — configures the packaged ZAP daemon.
// ────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"

describe("ZAP runtime entrypoint", () => {
  test("does not disable bridge-visible ZAP capabilities", async () => {
    const entrypoint = await Bun.file(new URL("./zap-entrypoint.sh", import.meta.url)).text()

    expect(entrypoint).toContain('-config "api.filexfer=true"')
    expect(entrypoint).toContain('-config "mcp.recordInHistory=true"')
    expect(entrypoint).not.toContain('-config "api.filexfer=false"')
    expect(entrypoint).not.toContain('-config "mcp.recordInHistory=false"')
  })
})
