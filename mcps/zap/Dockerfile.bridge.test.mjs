// ── ZAP Bridge Image Contract ───────────────────────────────────────
// Verifies the bridge image copies every repository-owned module imported by
// the stdio entrypoint so production containers cannot fail at startup.
// → mcps/zap/Dockerfile.bridge — builds the isolated bridge container.
// → mcps/zap/zap_bridge.mjs — implements the packaged entrypoint.
// ────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"

describe("ZAP bridge image context", () => {
  test("publishes the Cyberful license in image metadata", async () => {
    const dockerfile = await Bun.file(new URL("./Dockerfile.bridge", import.meta.url)).text()

    expect(dockerfile).toContain('org.opencontainers.image.licenses="AGPL-3.0-only"')
  })

  test("copies every local module imported by the bridge entrypoint", async () => {
    const bridge = await Bun.file(new URL("./zap_bridge.mjs", import.meta.url)).text()
    const dockerfile = await Bun.file(new URL("./Dockerfile.bridge", import.meta.url)).text()
    const copied = new Set(
      dockerfile
        .split(/\r?\n/)
        .filter((line) => line.startsWith("COPY "))
        .flatMap((line) => line.split(/\s+/).slice(1, -1)),
    )
    const localImports = Array.from(bridge.matchAll(/from\s+["']\.\/([^"']+)["']/g), (match) => match[1])

    expect(localImports.length).toBeGreaterThan(0)
    expect(localImports.filter((file) => !copied.has(file))).toEqual([])
  })
})
