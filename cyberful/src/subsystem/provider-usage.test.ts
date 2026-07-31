// ── Provider Usage Ledger Tests ─────────────────────────────────
// Proves per-call persistence, canonical totals, and exclusive root/subagent
// attribution without adding reasoning to generated tokens.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PROVIDER_USAGE_PATH, ProviderUsageLedger, readProviderUsageView } from "./provider-usage"

describe("provider usage ledger", () => {
  test("keeps reasoning inside generated and reconciles root against descendants", async () => {
    const workarea = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-provider-usage-")))
    try {
      const ledger = new ProviderUsageLedger({ workarea, sessionID: "session-1" })
      ledger.record({
        workflow: "pentest",
        phase: "exploit",
        attempt: 1,
        runID: "root",
        depth: 0,
        runKind: "root",
        provider: "openai-codex",
        route: "main",
        model: "gpt-5.6-sol",
        reasoningRequested: "ultra",
        reasoningEffective: "max",
        callKind: "generation",
        status: "completed",
        usage: { input: 100, cacheRead: 900, cacheWrite: 10, output: 50, reasoning: 40 },
        reportedTotalTokens: 1_100,
      })
      ledger.record({
        workflow: "pentest",
        phase: "exploit",
        attempt: 1,
        runID: "child",
        parentRunID: "root",
        depth: 1,
        runKind: "subagent",
        provider: "openai-codex",
        route: "subagent",
        model: "gpt-5.6-sol",
        reasoningRequested: "high",
        reasoningEffective: "high",
        callKind: "context-summary",
        status: "completed",
        usage: { input: 20, cacheRead: 80, cacheWrite: 0, output: 10, reasoning: 8 },
      })
      await ledger.close()

      const laterLedger = new ProviderUsageLedger({ workarea, sessionID: "session-2" })
      laterLedger.record({
        workflow: "pentest",
        phase: "recon",
        attempt: 1,
        runID: "later-root",
        depth: 0,
        runKind: "root",
        provider: "openai-codex",
        route: "main",
        model: "gpt-5.6-sol",
        reasoningRequested: "ultra",
        reasoningEffective: "max",
        callKind: "generation",
        status: "completed",
        usage: { input: 1_000, cacheRead: 2_000, cacheWrite: 0, output: 300, reasoning: 200 },
      })
      await laterLedger.close()

      expect(await readProviderUsageView(workarea, "session-1")).toMatchObject({
        root: { input: 100, cacheRead: 900, cacheWrite: 10, generated: 50, reasoning: 40 },
        subagents: { input: 20, cacheRead: 80, cacheWrite: 0, generated: 10, reasoning: 8 },
      })
      expect((await readProviderUsageView(workarea)).root.input).toBe(1_100)
      const rows = (await readFile(path.join(workarea, PROVIDER_USAGE_PATH), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(rows[0]).toMatchObject({
        canonicalVolume: 1_060,
        reportedTotalTokens: 1_100,
        totalDivergence: 40,
        generatedTokens: 50,
        reasoningTokens: 40,
      })
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })
})
