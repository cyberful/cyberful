// ── Expert Feed Tests ─────────────────────────────────────────────
// Verifies phase activity folding, status decoding, and readable turn
//   grouping for the TUI feed.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"

import {
  continuesExpertPhaseTurn,
  decodeExpertPhaseStatus,
  decodeExpertToolActivity,
  expertActorCardLabel,
  expertActorStateText,
  expertActorTextLabel,
  expertActorTone,
  expertPhaseDuration,
  expertPhaseLabel,
  foldExpertActivity,
  isExpertSemanticProgress,
  type ExpertPhaseEntry,
} from "./expert-feed"

const subsystem = { name: "codex", version: "0.144.3", label: "codex v0.144.3" }

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

test("delegated card attribution labels the card without a directional arrow", () => {
  expect(expertActorCardLabel("public_osint")).toBe("@public_osint")
})

test("delegated prose attribution points from the actor label to inline text", () => {
  expect(expertActorTextLabel("passive_hosts")).toBe("@passive_hosts → ")
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
  test("successful phase status keeps only the concise completion copy and validated successor", () => {
    const payload = JSON.stringify({
      ok: true,
      termination: "completed",
      backend: "codex",
      durationMs: 391_700,
      limitMs: 600_000,
      effectiveLimitMs: 600_000,
      deadlineAt: 600_000,
      approvalWaitMs: 12_000,
      exitCode: 0,
      warnings: [],
      handoff: { successor: "exploit", artifact: "RECON.md" },
    })
    const out = foldExpertActivity([], { ...act("status", payload, "", "status-ok"), phase: "recon" })
    expect(out[0]?.text).toBe("Phase completed")
    expect(out[0]?.phaseStatus?.handoff?.successor).toBe("exploit")
    expect(out[0]?.phaseStatus?.approvalWaitMs).toBe(12_000)
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
      actorTransitionID: "native-started",
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
    expect(expertActorTone(actor)).toBe("default")
    expect(expertActorTone({ id: "fallback-assist-1", role: "fallback" })).toBe("warning")
  })

  test("equal native call ids from simultaneous subsystems do not merge", () => {
    const other = { name: "other", version: "1", label: "other v1" }
    let entries = foldExpertActivity([], toolActivity("httpx", "same", {}, "codex-call"))
    entries = foldExpertActivity(entries, { ...toolActivity("scanner", "same", {}, "other-call"), subsystem: other })
    entries = foldExpertActivity(entries, {
      ...act("output", "other result", "same", "other-output"),
      subsystem: other,
    })
    expect(entries).toHaveLength(2)
    expect(entries.find((entry) => entry.subsystem.name === "codex")?.output).toBeUndefined()
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
      backend: "codex",
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
    expect(out[0]?.text).toContain("completed with warnings · codex · budget_exhausted")
    expect(out[0]?.phaseStatus?.effectiveLimitMs).toBe(30_000)
  })
})
