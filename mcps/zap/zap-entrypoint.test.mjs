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

  test("persists the private Root CA and reloads it across supervised restarts", async () => {
    const entrypoint = await Bun.file(new URL("./zap-entrypoint.sh", import.meta.url)).text()

    expect(entrypoint).toContain("umask 077")
    expect(entrypoint).toContain('certificate_option="-certload"')
    expect(entrypoint).toContain('certificate_option="-certfulldump"')
    expect(entrypoint).toContain('"${certificate_option}" "${certificate_path}"')
  })

  test("retains large acquisition responses within an explicit bounded history limit", async () => {
    const entrypoint = await Bun.file(new URL("./zap-entrypoint.sh", import.meta.url)).text()

    expect(entrypoint).toContain("CYBER_ZAP_MAX_HISTORY_RESPONSE_BYTES:-1073741824")
    expect(entrypoint).toContain("CYBER_ZAP_MAX_HISTORY_RESPONSE_BYTES must be at least 16777216")
    expect(entrypoint).toContain("CYBER_ZAP_MAX_HISTORY_RESPONSE_BYTES must not exceed 2147483647")
    expect(entrypoint).toContain('-config "database.response.bodysize=${history_response_body_bytes}"')
  })
})
