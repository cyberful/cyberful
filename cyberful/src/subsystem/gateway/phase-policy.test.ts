// ── Gateway Phase Policy Contract ───────────────────────────────
// Freezes phase ownership separately from MCP startup so changes cannot silently
// expose local runtimes or source mutation in the wrong workflow.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { gatewayPhasePolicy } from "./phase-policy"

describe("gateway phase policy", () => {
  test("keeps source import, audit runtimes, and EVM runtimes phase-scoped", () => {
    expect(gatewayPhasePolicy({ workflow: "code-audit", phase: "scope" })).toMatchObject({
      active: true,
      sourceImport: true,
      auditDiff: true,
      auditLab: false,
      evmLab: false,
      evmEvidence: false,
      liveTargetResearch: false,
      hypothesisResearch: true,
    })
    expect(gatewayPhasePolicy({ workflow: "code-audit", phase: "attack" })).toMatchObject({
      active: true,
      sourceImport: false,
      auditDiff: false,
      auditLab: true,
      liveTargetResearch: false,
    })
    expect(gatewayPhasePolicy({ workflow: "bug-bounty", phase: "recon" })).toMatchObject({
      active: true,
      sourceImport: true,
      evmLab: true,
      evmEvidence: true,
      liveTargetResearch: true,
    })
    expect(gatewayPhasePolicy({ workflow: "bug-bounty", phase: "report" })).toMatchObject({
      active: true,
      sourceImport: false,
      evmLab: false,
      evmEvidence: true,
      liveTargetResearch: false,
    })
    expect(gatewayPhasePolicy({ workflow: "code-audit", phase: "missing" })).toMatchObject({
      active: false,
      sourceImport: false,
      auditDiff: false,
      auditLab: false,
      evmLab: false,
      evmEvidence: false,
      liveTargetResearch: false,
    })
  })

  test("exposes Ghidra only to binary-analysis phases while preserving the workflow capability", () => {
    expect(gatewayPhasePolicy({ workflow: "pentest", phase: "brief" }).allows("ghidra")).toBe(false)
    expect(gatewayPhasePolicy({ workflow: "pentest", phase: "recon" }).allows("ghidra")).toBe(true)
    expect(gatewayPhasePolicy({ workflow: "bug-bounty", phase: "verify" }).allows("ghidra")).toBe(true)
    expect(gatewayPhasePolicy({ workflow: "bug-bounty", phase: "report" }).allows("ghidra")).toBe(false)
    expect(gatewayPhasePolicy({ workflow: "code-audit", phase: "scope" }).allows("ghidra")).toBe(false)
    expect(gatewayPhasePolicy({ workflow: "code-audit", phase: "index" }).allows("ghidra")).toBe(true)
    expect(gatewayPhasePolicy({ workflow: "code-audit", phase: "report" }).allows("ghidra")).toBe(false)
  })

  test("scopes complete native laboratories away from brief and report", () => {
    const brief = gatewayPhasePolicy({ workflow: "bug-bounty", phase: "brief" })
    const recon = gatewayPhasePolicy({ workflow: "bug-bounty", phase: "recon" })
    const exploit = gatewayPhasePolicy({ workflow: "bug-bounty", phase: "exploit" })
    const report = gatewayPhasePolicy({ workflow: "bug-bounty", phase: "report" })
    for (const capability of ["firmware-lab", "native-analysis", "native-debug", "fuzz-campaign", "protocol-campaign"] as const) {
      expect(brief.allows(capability)).toBe(false)
      expect(report.allows(capability)).toBe(false)
    }
    expect(recon.allows("firmware-lab")).toBe(true)
    expect(recon.allows("native-analysis")).toBe(true)
    expect(recon.allows("protocol-campaign")).toBe(true)
    expect(recon.allows("native-debug")).toBe(false)
    expect(exploit.allows("native-debug")).toBe(true)
    expect(exploit.allows("fuzz-campaign")).toBe(true)
    expect(gatewayPhasePolicy({ workflow: "code-audit", phase: "attack" }).allows("protocol-campaign")).toBe(false)
  })

  test("keeps Brief preflight-only while publishing its durable hypothesis ledger", () => {
    const brief = gatewayPhasePolicy({ workflow: "bug-bounty", phase: "brief" })
    expect(brief.hypothesisResearch).toBe(true)
    expect(brief.allows("browser")).toBe(true)
    expect(brief.allows("zap")).toBe(false)
    expect(brief.allows("cve-dictionary")).toBe(true)
    expect(gatewayPhasePolicy({ workflow: "code-audit", phase: "report" }).allows("cve-dictionary")).toBe(true)
    expect(gatewayPhasePolicy({ workflow: "ask", phase: "ask" }).allows("cve-dictionary")).toBe(true)
  })

  test("publishes the browser capability throughout live-target workflows and Ask but never Code Audit", () => {
    for (const workflow of ["pentest", "bug-bounty"])
      for (const phase of ["brief", "recon", "exploit", "hacker", "verify", "report"])
        expect(gatewayPhasePolicy({ workflow, phase }).allows("browser")).toBe(true)
    expect(gatewayPhasePolicy({ workflow: "ask", phase: "ask" }).allows("browser")).toBe(true)
    for (const phase of ["scope", "index", "trace", "hunt", "attack", "verify", "report"])
      expect(gatewayPhasePolicy({ workflow: "code-audit", phase }).allows("browser")).toBe(false)
  })
})
