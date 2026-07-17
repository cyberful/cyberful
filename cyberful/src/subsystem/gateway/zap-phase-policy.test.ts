// ── ZAP Phase Policy Tests ────────────────────────────────────────
// Verifies that Recon defers report generation and the terminal Report phase
// permits only its authorized-site scoped artifact operation.
// → cyberful/src/subsystem/gateway/zap-phase-policy.ts — implements the tested restriction.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { zapPhaseToolError } from "./zap-phase-policy"

describe("phase policy for ZAP reports", () => {
  test("defers report generation while Recon is still active without hiding the official tool", () => {
    expect(zapPhaseToolError("recon", "zap_generate_report")).toContain("after Recon completes")
    expect(zapPhaseToolError("recon", "zap_generate_scoped_report")).toContain("after Recon completes")
    expect(zapPhaseToolError("recon", "zap_history_search")).toBeUndefined()
    expect(zapPhaseToolError("report", "zap_generate_report")).toContain("zap_generate_scoped_report")
    expect(zapPhaseToolError("report", "zap_generate_scoped_report")).toBeUndefined()
    expect(zapPhaseToolError(undefined, "zap_generate_report")).toBeUndefined()
  })
})
