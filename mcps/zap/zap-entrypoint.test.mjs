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

  test("raises the cache of an existing persistent history before ZAP reopens it", async () => {
    const entrypoint = await Bun.file(new URL("./zap-entrypoint.sh", import.meta.url)).text()

    expect(entrypoint).toContain("SET FILES CACHE SIZE 262144")
    expect(entrypoint).toContain("grep -q '^SET FILES CACHE SIZE [0-9][0-9]*$'")
    expect(entrypoint).toContain('mv "${session_script_next}" "${session_script}"')
    expect(entrypoint.indexOf("SET FILES CACHE SIZE 262144")).toBeLessThan(entrypoint.indexOf("exec /zap/zap-x.sh"))
  })

  test("raises the bundled template cache used by new persistent histories", async () => {
    const dockerfile = await Bun.file(new URL("../cyberful-os/Dockerfile", import.meta.url)).text()

    expect(dockerfile).toContain("s/^SET FILES CACHE SIZE 32000$/SET FILES CACHE SIZE 262144/")
    expect(dockerfile).toContain("grep -qx 'SET FILES CACHE SIZE 262144' /zap/db/zapdb.script")
  })
})
