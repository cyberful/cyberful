// ── Expert Feed Tests ─────────────────────────────────────────────
// Verifies phase activity folding, status decoding, and readable turn
//   grouping for the TUI feed.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"

import {
  continuesExpertPhaseTurn,
  decodeExpertContextCompaction,
  decodeExpertFindingMaturation,
  decodeExpertPhaseStatus,
  decodeExpertProviderRetry,
  decodeExpertRuntimeDiagnostic,
  decodeExpertToolActivity,
  expertActorIdentityText,
  expertActorStateText,
  expertContextCompactionText,
  expertPhaseDuration,
  expertPhaseLabel,
  expertRuntimeDiagnosticText,
  expertRewardText,
  foldExpertActivity,
  isExpertSemanticProgress,
  type ExpertPhaseEntry,
} from "./expert-feed"

const subsystem = { name: "pi", version: "0.81.1", label: "pi v0.81.1" }

describe("continuesExpertPhaseTurn", () => {
  const entry = (
    phase: string,
    kind: ExpertPhaseEntry["kind"],
    source = subsystem,
    actor?: ExpertPhaseEntry["actor"],
  ) => ({ phase, kind, subsystem: source, actor })

  test("keeps tool and status rows under the current public update", () => {
    expect(continuesExpertPhaseTurn(entry("exploit", "text"), entry("exploit", "tool"))).toBe(true)
    expect(continuesExpertPhaseTurn(entry("exploit", "tool"), entry("exploit", "status"))).toBe(true)
  })

  test("starts a new turn for public prose or a different phase", () => {
    expect(continuesExpertPhaseTurn(entry("exploit", "tool"), entry("exploit", "text"))).toBe(false)
    expect(continuesExpertPhaseTurn(entry("recon", "tool"), entry("exploit", "tool"))).toBe(false)
  })

  test("keeps delegated prose grouped but separates simultaneous subsystem sources", () => {
    expect(
      continuesExpertPhaseTurn(
        entry("recon", "agent", subsystem, { id: "child", label: "surface" }),
        entry("recon", "text", subsystem, { id: "child", label: "surface" }),
      ),
    ).toBe(true)
    expect(
      continuesExpertPhaseTurn(
        entry("recon", "tool"),
        entry("recon", "tool", { name: "other", version: "1", label: "other v1" }),
      ),
    ).toBe(false)
  })
})

test("delegated identity composes the exact muted-wrapper label", () => {
  const identity = expertActorIdentityText({
    id: "child-1",
    label: "api-monster",
    displayName: "api-monster",
    emoji: "👾",
    role: "subagent",
  })
  expect(`@{${identity}}`).toBe("@{👾 api-monster}")
})

test("semantic progress is recognized for compact muted styling without changing its JSON", () => {
  const text = JSON.stringify({ semanticProgress: { phase: "recon", count: 2 } })
  expect(isExpertSemanticProgress(text)).toBe(true)
  expect(isExpertSemanticProgress('{"status":"ready"}')).toBe(false)
  expect(isExpertSemanticProgress("not-json")).toBe(false)
})

// A phase activity as it reaches the store: the event's kind + its two string fields (a "tool" packs
// {callID,input} JSON in `text` and its name in `tool`; an "output" keeps its result in `text` and the
// pairing callID in `tool`). id/sessionID/timestamp/phase and the source subsystem round out the row.
const act = (kind: "text" | "tool" | "output" | "status", text: string, tool: string, id = "e") => ({
  id,
  sessionID: "s",
  timestamp: 0,
  phase: "recon",
  subsystem,
  kind,
  text,
  tool,
})
const toolActivity = (name: string, callID: string, input: unknown, id = "e") =>
  act("tool", JSON.stringify({ callID, input }), name, id)

describe("decodeExpertToolActivity", () => {
  test("unpacks the {callID,input} JSON a tool activity carries in `text`", () => {
    expect(decodeExpertToolActivity(JSON.stringify({ callID: "c1", input: { args: ["-x"] } }))).toEqual({
      callID: "c1",
      input: { args: ["-x"] },
    })
  })

  test("degrades a malformed or pre-feature payload to empty input / no callID (never throws)", () => {
    expect(decodeExpertToolActivity("browser_navigate")).toEqual({ callID: "", input: {} })
    // Valid JSON but missing the callID → unpaired, but the input is still recovered.
    expect(decodeExpertToolActivity(JSON.stringify({ input: { a: 1 } }))).toEqual({ callID: "", input: { a: 1 } })
  })
})

describe("foldExpertActivity", () => {
  test("decodes a non-blocking finding maturation card with published upside", () => {
    const payload = JSON.stringify({
      findingMaturation: {
        workflow: "bug-bounty",
        phase: "exploit",
        findingID: "fnd_001",
        alias: "BBP-001",
        title: "Cross-tenant export disclosure",
        currentSeverity: "MEDIUM",
        targetSeverity: "HIGH",
        checkpoint: {
          id: "mat_001",
          signature: "signature",
          promptedAt: "2026-08-10T08:00:00.000Z",
          questions: [
            "What is the strongest impact currently supported by the evidence?",
            "Which authorized test would close that gap most efficiently?",
          ],
          reward: {
            policyRevision: "reward-r1",
            policyKind: "MONETARY",
            groupID: "web",
            current: { severity: "MEDIUM", minimum: 500, maximum: 1_000, unit: "MONEY", currency: "USD" },
            target: { severity: "HIGH", minimum: 3_000, maximum: 5_000, unit: "MONEY", currency: "USD" },
            upside: { minimum: 2_000, maximum: 4_500, unit: "MONEY", currency: "USD" },
          },
        },
      },
    })

    const decoded = decodeExpertFindingMaturation(payload)
    expect(decoded).toMatchObject({
      findingID: "fnd_001",
      checkpoint: { reward: { upside: { minimum: 2_000, maximum: 4_500 } } },
    })
    expect(expertRewardText(decoded?.checkpoint.reward?.upside)).toBe("USD 2000–4500")
    const out = foldExpertActivity([], act("status", payload, "", "maturation"))
    expect(out[0]?.findingMaturation).toEqual(decoded)
    expect(out[0]?.text).toBe("Finding maturation checkpoint")
  })

  test("rejects malformed maturation envelopes without disturbing the status feed", () => {
    const payload = JSON.stringify({ findingMaturation: { findingID: "fnd_001", questions: "not-an-array" } })
    expect(decodeExpertFindingMaturation(payload)).toBeUndefined()
    expect(foldExpertActivity([], act("status", payload, "", "malformed"))[0]?.text).toBe(payload)
  })

  test("decodes provider retry telemetry for compact grouped styling", () => {
    expect(
      decodeExpertProviderRetry("Provider retry scheduled: attempt 1/3 after 624 ms (server_is_overloaded)."),
    ).toEqual({
      state: "scheduled",
      attempt: 1,
      maxRetries: 3,
      delayMs: 624,
      providerCode: "server_is_overloaded",
    })
    expect(decodeExpertProviderRetry("Provider retry succeeded: attempt 1/3.")).toEqual({
      state: "succeeded",
      attempt: 1,
      maxRetries: 3,
    })
    expect(decodeExpertProviderRetry("Provider retry succeeded eventually.")).toBeUndefined()
    expect(decodeExpertProviderRetry("Provider retry timed_out: attempt 1/3 (retry_attempt_timeout).")).toEqual({
      state: "timed_out",
      attempt: 1,
      maxRetries: 3,
      providerCode: "retry_attempt_timeout",
    })

    const out = foldExpertActivity([], act("status", "Provider retry succeeded: attempt 1/3.", "", "provider-retry"))
    expect(out[0]?.providerRetry?.state).toBe("succeeded")
  })

  test("renders a tool diagnostic as a compact recoverable issue with sanitized detail", () => {
    const payload = JSON.stringify({
      runtimeDiagnostic: {
        component: "gateway",
        profile: "shell",
        stage: "tool",
        severity: "error",
        errorClass: "McpError",
        message: "Session variable account1_username is not saved.",
        path: "raw/operations/runtime-diagnostics.jsonl",
      },
    })
    const diagnostic = decodeExpertRuntimeDiagnostic(payload)
    expect(diagnostic?.stage).toBe("tool")
    if (!diagnostic) throw new Error("Structured runtime diagnostic was not decoded")
    expect(expertRuntimeDiagnosticText(diagnostic)).toBe(
      "ⓘ Tool failed; run continues · gateway/shell · McpError · Session variable account1_username is not saved." +
        " · log: raw/operations/runtime-diagnostics.jsonl",
    )

    const out = foldExpertActivity([], act("status", payload, "", "runtime-diagnostic"))
    expect(out[0]?.runtimeDiagnostic).toEqual(diagnostic)
    expect(out[0]?.text).toContain("Tool failed; run continues")
  })

  test("renders the exact interrupted AgentRun identity and budget termination", () => {
    const diagnostic = decodeExpertRuntimeDiagnostic(
      JSON.stringify({
        runtimeDiagnostic: {
          component: "agent",
          runID: "run-child-7",
          parentRunID: "run-root-1",
          role: "subagent",
          termination: "budget_exhausted",
          profile: "budget_exhausted",
          stage: "provider",
          severity: "error",
          errorClass: "AgentRunFailure",
          code: "budget_exhausted",
          message: "AgentRun terminated with budget_exhausted.",
          path: "raw/operations/runtime-diagnostics.jsonl",
        },
      }),
    )

    expect(diagnostic).toBeDefined()
    expect(expertRuntimeDiagnosticText(diagnostic!)).toContain(
      "agent/budget_exhausted · subagent run-child-7 · budget_exhausted · AgentRunFailure (budget_exhausted)",
    )
  })

  test("replays legacy path-only diagnostics with a neutral explanatory message", () => {
    const text = "Runtime diagnostic: gateway · GatewayStderr · raw/operations/runtime-diagnostics.jsonl"
    const diagnostic = decodeExpertRuntimeDiagnostic(text)
    expect(diagnostic).toMatchObject({
      component: "gateway",
      stage: "startup",
      severity: "warning",
      errorClass: "GatewayStderr",
    })
    expect(diagnostic?.message).toBe("Sanitized details are available in the local diagnostic log.")
  })

  test("folds one structured compaction completion into concise neutral telemetry", () => {
    const payload = JSON.stringify({
      contextCompaction: {
        state: "completed",
        mode: "proactive",
        estimatedTokensBefore: 318_883,
        estimatedTokensAfter: 99_006,
        messagesRemoved: 0,
        toolResultsVirtualized: 18,
        artifactsPreserved: 18,
        modelSummary: false,
      },
    })
    const decoded = decodeExpertContextCompaction(payload)
    expect(decoded).toMatchObject({
      state: "completed",
      mode: "proactive",
      toolResultsVirtualized: 18,
    })
    if (!decoded) throw new Error("Structured compaction status was not decoded")
    expect(expertContextCompactionText(decoded)).toBe(
      "↻ Context compacted · 318.9K → 99.0K tokens · 18 tool results virtualized · 18 complete artifacts preserved",
    )

    const out = foldExpertActivity([], act("status", payload, "", "context-compaction"))
    expect(out).toHaveLength(1)
    expect(out[0]?.phaseStatus).toBeUndefined()
    expect(out[0]?.contextCompaction).toEqual(decoded)
    expect(out[0]?.text).toBe(expertContextCompactionText(decoded))

    const legacyPayload = JSON.stringify({
      contextCompaction: {
        ...JSON.parse(payload).contextCompaction,
        modelSummary: undefined,
      },
    })
    expect(decodeExpertContextCompaction(legacyPayload)?.modelSummary).toBe(false)
  })

  test("renders exhausted deterministic compaction as a muted no-op", () => {
    const payload = JSON.stringify({
      contextCompaction: {
        state: "noop",
        mode: "proactive",
        reason: "no_candidates",
        estimatedTokensBefore: 172_000,
        estimatedTokensAfter: 172_000,
        messagesRemoved: 0,
        toolResultsVirtualized: 0,
        artifactsPreserved: 0,
        modelSummary: false,
      },
    })
    const decoded = decodeExpertContextCompaction(payload)

    expect(decoded?.state).toBe("noop")
    if (!decoded) throw new Error("Structured no-op compaction status was not decoded")
    expect(expertContextCompactionText(decoded)).toBe(
      "↻ Context compaction exhausted · 172.0K → 172.0K tokens · 0 tool results virtualized · 0 complete artifacts preserved",
    )
  })

  test("successful phase status keeps only the concise completion copy and validated successor", () => {
    const payload = JSON.stringify({
      ok: true,
      termination: "completed",
      backend: "pi",
      durationMs: 391_700,
      limitMs: 600_000,
      effectiveLimitMs: 600_000,
      deadlineAt: 600_000,
      approvalWaitMs: 12_000,
      targetCooldownWaitMs: 180_000,
      exitCode: 0,
      warnings: [],
      handoff: { successor: "exploit", artifact: "RECON.md" },
    })
    const out = foldExpertActivity([], { ...act("status", payload, "", "status-ok"), phase: "recon" })
    expect(out[0]?.text).toBe("Phase completed")
    expect(out[0]?.phaseStatus?.handoff?.successor).toBe("exploit")
    expect(out[0]?.phaseStatus?.approvalWaitMs).toBe(12_000)
    expect(out[0]?.phaseStatus?.targetCooldownWaitMs).toBe(180_000)
    expect(expertPhaseLabel(out[0]?.phase ?? "")).toBe("RECON")
    expect(expertPhaseLabel(out[0]?.phaseStatus?.handoff?.successor ?? "")).toBe("EXPLOIT")
    expect(expertPhaseDuration(out[0]?.phaseStatus?.durationMs ?? 0)).toBe("6m 32s")
  })

  test("a tool call becomes a running card carrying its args + callID (output not yet known)", () => {
    const out = foldExpertActivity([], toolActivity("nuclei", "c1", { args: ["-tags", "laravel"] }))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: "tool",
      tool: "nuclei",
      callID: "c1",
      input: { args: ["-tags", "laravel"] },
      status: "running",
    })
    expect(out[0].output).toBeUndefined()
  })

  test("the matching result MERGES into its call (by callID) — one card, not a card + a loose block", () => {
    const withCall = foldExpertActivity([], toolActivity("nuclei", "c1", {}))
    const merged = foldExpertActivity(withCall, act("output", "3 findings", "c1", "e2"))
    expect(merged).toHaveLength(1) // merged in place — no standalone output row
    expect(merged[0]).toMatchObject({ kind: "tool", tool: "nuclei", output: "3 findings", status: "completed" })
  })

  test("delegated actor lifecycle and attributed work stay readable and idempotent", () => {
    let entries: ExpertPhaseEntry[] = []
    const actor = { id: "child-1", label: "surface", parentID: "root" }
    entries = foldExpertActivity(entries, {
      ...act("text", "", "", "started"),
      kind: "agent",
      actor,
      actorState: "started",
      actorTransitionID: "delegated-started",
    })
    entries = foldExpertActivity(entries, {
      ...act("text", "", "", "active"),
      kind: "agent",
      actor,
      actorState: "active",
      actorTransitionID: "turn-1-started",
    })
    entries = foldExpertActivity(entries, {
      ...act("text", "", "", "active-redelivered"),
      kind: "agent",
      actor,
      actorState: "active",
      actorTransitionID: "turn-1-started",
    })
    entries = foldExpertActivity(entries, { ...toolActivity("httpx", "call", { url: "x" }, "tool"), actor })
    entries = foldExpertActivity(entries, { ...act("output", "200 OK", "call", "output"), actor })
    entries = foldExpertActivity(entries, {
      ...act("text", "", "", "completed"),
      kind: "agent",
      actor,
      actorState: "completed",
      actorTransitionID: "turn-1-completed",
    })

    expect(entries).toHaveLength(4)
    expect(entries.map((entry) => entry.actorState).filter(Boolean)).toEqual(["started", "active", "completed"])
    expect(entries.find((entry) => entry.tool === "httpx")).toMatchObject({
      actor,
      output: "200 OK",
      status: "completed",
    })
    expect(expertActorStateText("interacted")).toBe("received follow-up")
  })

  test("absorbs linked child lifecycle into its delegate_task card", () => {
    let entries = foldExpertActivity(
      [],
      toolActivity("delegate_task", "delegate-1", { task: "inspect public metadata" }, "delegate"),
    )
    const actor = {
      id: "child-1",
      label: "subagent · provider/model",
      parentID: "root",
      sourceCallID: "delegate-1",
      provider: "provider",
      model: "model",
      startedAt: 100,
      lastActivityAt: 250,
      toolCalls: 3,
    }
    entries = foldExpertActivity(entries, {
      ...act("text", "", "", "child-start"),
      kind: "agent",
      actor,
      actorState: "started",
      actorTransitionID: "child-1:created",
    })
    entries = foldExpertActivity(entries, {
      ...act("text", "", "", "child-end"),
      kind: "agent",
      actor: { ...actor, lastActivityAt: 900, toolCalls: 7 },
      actorState: "completed",
      actorTransitionID: "child-1:finished",
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      tool: "delegate_task",
      callID: "delegate-1",
      delegation: {
        state: "completed",
        actor: {
          id: "child-1",
          sourceCallID: "delegate-1",
          provider: "provider",
          model: "model",
          toolCalls: 7,
        },
      },
    })
  })

  test("equal provider call ids from simultaneous subsystems do not merge", () => {
    const other = { name: "other", version: "1", label: "other v1" }
    let entries = foldExpertActivity([], toolActivity("httpx", "same", {}, "pi-call"))
    entries = foldExpertActivity(entries, { ...toolActivity("scanner", "same", {}, "other-call"), subsystem: other })
    entries = foldExpertActivity(entries, {
      ...act("output", "other result", "same", "other-output"),
      subsystem: other,
    })
    expect(entries).toHaveLength(2)
    expect(entries.find((entry) => entry.subsystem.name === "pi")?.output).toBeUndefined()
    expect(entries.find((entry) => entry.subsystem.name === "other")?.output).toBe("other result")
  })

  test("parallel calls pair by callID, not by position", () => {
    let entries: ExpertPhaseEntry[] = []
    entries = foldExpertActivity(entries, toolActivity("httpx", "c1", {}, "a"))
    entries = foldExpertActivity(entries, toolActivity("nuclei", "c2", {}, "b"))
    // c2's result arrives FIRST; it must land on the nuclei call, not the positionally-first httpx call.
    entries = foldExpertActivity(entries, act("output", "nuclei out", "c2", "c"))
    expect(entries).toHaveLength(2)
    expect(entries.find((e) => e.tool === "nuclei")?.output).toBe("nuclei out")
    expect(entries.find((e) => e.tool === "httpx")?.output).toBeUndefined()
  })

  test("a result with no matching call (a dropped tool frame) is kept as a standalone block", () => {
    const out = foldExpertActivity([], act("output", "orphaned output", "cX", "e2"))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: "output", text: "orphaned output" })
  })

  test("prose appends as a text row; a re-delivered event does not duplicate", () => {
    const once = foldExpertActivity([], act("text", "mapping the surface", "", "e1"))
    expect(once).toHaveLength(1)
    expect(once[0]).toMatchObject({ kind: "text", text: "mapping the surface", subsystem })
    const twice = foldExpertActivity(once, act("text", "mapping the surface", "", "e1"))
    expect(twice).toHaveLength(1) // id-idempotent
  })

  test("host terminal telemetry becomes a readable status row without losing typed fields", () => {
    const payload = JSON.stringify({
      ok: false,
      termination: "budget_exhausted",
      backend: "pi",
      durationMs: 75,
      limitMs: 2_700_000,
      effectiveLimitMs: 30_000,
      deadlineAt: 31_000,
      exitCode: 128,
      warnings: ["partial result retained"],
    })
    expect(decodeExpertPhaseStatus(payload)?.termination).toBe("budget_exhausted")
    const out = foldExpertActivity([], act("status", payload, "", "status-1"))
    expect(out[0]?.kind).toBe("status")
    expect(out[0]?.text).toContain("Phase failed · pi · budget_exhausted · worker exit 128")
    expect(out[0]?.phaseStatus?.effectiveLimitMs).toBe(30_000)
  })
})
