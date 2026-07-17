// ── Installed Codex Version Gate ─────────────────────────────────
// Verifies that the host executable used by builds reports the exact version
// whose app-server contract and documentation are pinned by the repository.
// → cyberful/src/subsystem/codex-compat.integration.test.ts — proves the protocol independently of the pin.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { CODEX_PINNED_VERSION, codexVersion } from "@/dependency/codex"

test("the installed Codex executable reports the repository pin", async () => {
  const version = await codexVersion()
  expect(version).not.toBeNull()
  expect(version).toBe(CODEX_PINNED_VERSION)
})
