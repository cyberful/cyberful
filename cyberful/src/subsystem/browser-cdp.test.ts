// ── Browser CDP Profile Tests ────────────────────────────────────
// Verifies that a missing Chromium DevToolsActivePort file is treated as an
// unavailable endpoint rather than a usable browser connection.
// → cyberful/src/subsystem/browser-cdp.ts — reads and validates the profile endpoint.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SubsystemBrowserCdp } from "./browser-cdp"

describe("browser-cdp", () => {
  test("returns no debugging endpoint when the profile has no port record", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-"))
    try {
      expect(await SubsystemBrowserCdp.readCdpPort(dir)).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
