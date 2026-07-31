// ── Analysis Reconciliation Ledger Tests ────────────────────────
// Verifies concrete hypotheses block handoff until resolved and scope
//   uncertainty requires an evidenced action-specific resolution pass.
// → cyberful/src/subsystem/gateway/analysis-ledger.ts — owns the ledger.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AnalysisLedger } from "./analysis-ledger"

describe("analysis ledger", () => {
  test("requires every registered discriminator to resolve and reconcile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "analysis-ledger-"))
    try {
      const ledger = new AnalysisLedger(root, "exploit")
      await ledger.handle({
        action: "register",
        id: "kms-replay",
        objective: "Test replay freshness enforcement",
        discriminator: "Mutated timestamp produces a distinct authorization result",
        surface: "POST /kms/decrypt",
        candidate_tools: ["zap_history_replay"],
      })
      expect(await ledger.handoffError()).toContain("kms-replay")
      await ledger.handle({
        action: "resolve",
        id: "kms-replay",
        outcome: "disproved",
        evidence: ["ZAP message 41 returned the same freshness rejection as the control"],
        omitted_tools: [],
      })
      expect(await ledger.handoffError()).toContain("requires reconcile")
      await ledger.handle({ action: "reconcile" })
      expect(await ledger.handoffError()).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects unresolved as generic caution without a complete resolution pass", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "analysis-unresolved-"))
    try {
      const ledger = new AnalysisLedger(root, "recon")
      await ledger.handle({
        action: "register",
        id: "third-party-api",
        objective: "Classify one dependency action",
        discriminator: "Policy authorizes or excludes one POST",
        surface: "api.partner.test",
        candidate_tools: [],
      })
      await expect(
        ledger.handle({
          action: "resolve",
          id: "third-party-api",
          outcome: "unresolved",
          blocker: "policy_scope",
          evidence: [],
          omitted_tools: [],
        }),
      ).rejects.toThrow("requires unresolved evidence")
      await ledger.handle({
        action: "resolve",
        id: "third-party-api",
        outcome: "unresolved",
        blocker: "policy_scope",
        evidence: [],
        omitted_tools: [{ tool: "zap_history_replay", reason: "policy_scope" }],
        unresolved: {
          exact_action: "POST one mutated request",
          asset: "api.partner.test",
          required_rule: "third-party API authorization",
          sources_checked: ["Program policy dated 2026-07-29"],
          ambiguity: "The API is observed but neither listed nor excluded.",
          resolution_attempt: "Checked the complete asset and exclusion tables.",
          next_step: "Ask whether the named API host is authorized.",
        },
      })
      await ledger.handle({ action: "reconcile" })
      expect(await ledger.handoffError()).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
