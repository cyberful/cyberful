// ── ZAP Lifecycle Policy Tests ──────────────────────────────────
// Pentest owns engagement-wide ZAP state; Code Audit remains offline.
// → cyberful/src/session/prompt.ts — selects the lifecycle.
// ────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { zapRuntimeLifecycle } from "./prompt"

describe("ZAP lifecycle policy", () => {
  test("enables ZAP only for Pentest", () => {
    expect(zapRuntimeLifecycle("pentest")).toBe("engagement")
    expect(zapRuntimeLifecycle("code-audit")).toBe("disabled")
    expect(zapRuntimeLifecycle("ask")).toBe("disabled")
    expect(zapRuntimeLifecycle("unknown")).toBe("disabled")
  })
})
