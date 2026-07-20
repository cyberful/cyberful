// ── Expert Phase Feed Model ──────────────────────────────────────
// Decodes public phase status and activity, merges tool calls with their later
//   results, and folds readable turns without depending on SolidJS or rendering.
// → cyberful/src/cli/cmd/tui/context/sync.tsx — stores the folded live feed.
// ─────────────────────────────────────────────────────────────────

import type { PhaseActivityActor, PhaseActivityActorState, SubsystemDescriptor } from "@/session/event-v2"
import { Locale } from "@/util/locale"
import { isRecord } from "@/util/record"

// One item of a live Expert phase excursion, shown in the transcript as it streams: a tool the Expert
// called (with its args + paired result), or a snippet of its prose. `phase` is the excursion phase the
// item belongs to.
export type ExpertPhaseEntry = {
  id: string
  sessionID: string
  timestamp: number
  phase: string
  subsystem: SubsystemDescriptor
  kind: "text" | "tool" | "output" | "status" | "agent"
  text: string
  tool: string
  // ── Tool Results Reuse Their Call Entry ─────────────────────────
  // A tool activity arrives with call identity and input, then a later output
  // frame supplies its result. Folding by call identity updates one card from
  // running to completed. Prose and unmatched output rows omit these fields,
  // preserving their distinct rendering contracts.
  // ─────────────────────────────────────────────────────────────────
  callID?: string
  input?: unknown
  output?: string
  status?: "running" | "completed"
  phaseStatus?: ExpertPhaseStatus
  actor?: PhaseActivityActor
  actorState?: PhaseActivityActorState
  actorTransitionID?: string
}

export type ExpertPhaseStatus = {
  ok: boolean
  termination: string
  backend: string
  durationMs: number
  limitMs: number
  effectiveLimitMs: number
  deadlineAt: number
  approvalWaitMs?: number
  exitCode: number
  warnings: string[]
  handoff?: {
    successor: string
  }
}

// ── Public Updates Delimit Readable Phase Turns ──────────────────
// One subsystem run can stream many public updates and tool calls. Each root
// prose update begins a readable turn, while delegated prose and following rows
// remain attached to it. A phase or subsystem change always breaks grouping so
// concurrent producers cannot inherit presentation state from one another.
// ─────────────────────────────────────────────────────────────────
export function continuesExpertPhaseTurn(
  previous: Pick<ExpertPhaseEntry, "phase" | "kind" | "subsystem" | "actor"> | undefined,
  current: Pick<ExpertPhaseEntry, "phase" | "kind" | "subsystem" | "actor"> | undefined,
): boolean {
  if (
    !previous ||
    !current ||
    previous.phase !== current.phase ||
    !sameSubsystem(previous.subsystem, current.subsystem)
  )
    return false
  return current.kind !== "text" || Boolean(current.actor?.label)
}

export function expertActorStateText(state: PhaseActivityActorState): string {
  if (state === "started") return "started"
  if (state === "active") return "active"
  if (state === "interacted") return "received follow-up"
  if (state === "completed") return "completed"
  if (state === "interrupted") return "interrupted"
  return "failed"
}

export function expertActorCardLabel(label: string): string {
  return `@${label}`
}

export function expertActorTextLabel(label: string): string {
  return `@${label} → `
}

export function isExpertSemanticProgress(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) && isRecord(value.semanticProgress)
  } catch {
    return false
  }
}

export function decodeExpertPhaseStatus(text: string): ExpertPhaseStatus | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (
      !isRecord(value) ||
      typeof value.ok !== "boolean" ||
      typeof value.termination !== "string" ||
      typeof value.backend !== "string" ||
      typeof value.durationMs !== "number" ||
      typeof value.limitMs !== "number" ||
      typeof value.effectiveLimitMs !== "number" ||
      typeof value.deadlineAt !== "number" ||
      typeof value.exitCode !== "number"
    )
      return undefined
    return {
      ok: value.ok,
      termination: value.termination,
      backend: value.backend,
      durationMs: value.durationMs,
      limitMs: value.limitMs,
      effectiveLimitMs: value.effectiveLimitMs,
      deadlineAt: value.deadlineAt,
      approvalWaitMs:
        typeof value.approvalWaitMs === "number" && value.approvalWaitMs >= 0 ? value.approvalWaitMs : undefined,
      exitCode: value.exitCode,
      warnings: Array.isArray(value.warnings)
        ? value.warnings.filter((warning): warning is string => typeof warning === "string")
        : [],
      handoff: decodeExpertPhaseHandoff(value.handoff),
    }
  } catch {
    return undefined
  }
}

function decodeExpertPhaseHandoff(value: unknown): ExpertPhaseStatus["handoff"] {
  if (!isRecord(value) || typeof value.successor !== "string") return undefined
  return { successor: value.successor }
}

// Status rows use product-facing chain names rather than internal runner labels.
export function expertPhaseLabel(phase: string): string {
  return phase
    .replace(/^pentest-/, "")
    .replaceAll("-", " ")
    .toUpperCase()
}

// Human status rounds a completed run to whole seconds: 391.7s is easier to scan as 6m 32s.
export function expertPhaseDuration(durationMs: number): string {
  return Locale.duration(durationMs < 1000 ? durationMs : Math.round(durationMs / 1000) * 1000)
}

function phaseStatusText(status: ExpertPhaseStatus): string {
  if (status.ok) return "Phase completed"
  const elapsed = (status.durationMs / 1000).toFixed(1)
  const limit = (status.limitMs / 60_000).toFixed(1)
  const effective = (status.effectiveLimitMs / 60_000).toFixed(1)
  const approvalWait = status.approvalWaitMs
    ? ` · approval wait ${expertPhaseDuration(status.approvalWaitMs)}`
    : ""
  const warning = status.warnings[0]
    ? ` · ${status.warnings[0]}${status.warnings.length > 1 ? ` (+${status.warnings.length - 1})` : ""}`
    : ""
  return (
    `completed with warnings · ${status.backend} · ${status.termination} · exit ${status.exitCode} · ${elapsed}s · ` +
    `limit ${limit}m (effective ${effective}m) · deadline ${new Date(status.deadlineAt).toISOString()}` +
    `${approvalWait}${warning}`
  )
}

// ── Malformed Tool Activity Degrades To A Name-Only Card ─────────
// Phase activity has a generated string payload rather than dedicated tool
// columns, so call identity and input arrive as JSON in `text`. The boundary
// decodes and narrows both fields once. Old, partial, or malformed frames return
// an empty identity and input, preserving the feed without trusting their shape.
// ─────────────────────────────────────────────────────────────────
export function decodeExpertToolActivity(text: string): { callID: string; input: unknown } {
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed))
      return { callID: typeof parsed.callID === "string" ? parsed.callID : "", input: parsed.input ?? {} }
  } catch {
    // Not JSON (old format or a partial frame) — fall through to the empty default.
  }
  return { callID: "", input: {} }
}

// ── Tool Calls And Results Fold Into One Feed Entry ──────────────
// Text and tool activities append rows, but an output joins the prior tool row
// with the same call identity so users see one complete card. An unmatched
// output remains a standalone row rather than disappearing. Host event identity
// prevents ordinary re-delivery, while native call identity catches a source
// item wrapped in a new bus event. The fold stays pure for deterministic replay.
// ─────────────────────────────────────────────────────────────────
export function foldExpertActivity(
  entries: ExpertPhaseEntry[],
  a: {
    id: string
    sessionID: string
    timestamp: number
    phase: string
    subsystem: SubsystemDescriptor
    kind: "text" | "tool" | "output" | "status" | "agent"
    text: string
    tool: string
    actor?: PhaseActivityActor
    actorState?: PhaseActivityActorState
    actorTransitionID?: string
  },
): ExpertPhaseEntry[] {
  const base = {
    id: a.id,
    sessionID: a.sessionID,
    timestamp: a.timestamp,
    phase: a.phase,
    subsystem: a.subsystem,
    ...(a.actor ? { actor: a.actor } : {}),
  }
  if (a.kind === "agent") {
    if (!a.actor?.label || !a.actorState) return entries
    if (
      entries.some(
        (entry) =>
          sameActivityScope(entry, a) &&
          entry.kind === "agent" &&
          (a.actorTransitionID ? entry.actorTransitionID === a.actorTransitionID : entry.id === a.id),
      )
    )
      return entries
    return [
      ...entries,
      {
        ...base,
        kind: "agent",
        text: "",
        tool: "",
        actorState: a.actorState,
        actorTransitionID: a.actorTransitionID,
      },
    ]
  }
  if (a.kind === "status") {
    if (entries.some((entry) => entry.id === a.id)) return entries
    const status = decodeExpertPhaseStatus(a.text)
    return [
      ...entries,
      { ...base, kind: "status", text: status ? phaseStatusText(status) : a.text, tool: "", phaseStatus: status },
    ]
  }
  if (a.kind === "output") {
    const callID = a.tool // an output activity carries the pairing callID in `tool`
    const idx = callID
      ? entries.findIndex((entry) => entry.kind === "tool" && entry.callID === callID && sameActivityScope(entry, a))
      : -1
    if (idx >= 0) {
      const next = entries.slice()
      next[idx] = { ...next[idx], output: a.text, status: "completed" }
      return next
    }
    if (entries.some((e) => e.id === a.id)) return entries
    return [...entries, { ...base, kind: "output", text: a.text, tool: "" }]
  }
  if (entries.some((e) => e.id === a.id)) return entries
  if (a.kind === "tool") {
    const { callID, input } = decodeExpertToolActivity(a.text)
    // App-server may redeliver the same native item through more than one transport notification. Bus
    // event ids are host-generated, so callID is the stable source identity that prevents duplicate
    // spawn/activity cards even when the wrapper event receives a fresh id.
    if (
      callID &&
      entries.some((entry) => entry.kind === "tool" && entry.callID === callID && sameActivityScope(entry, a))
    )
      return entries
    return [...entries, { ...base, kind: "tool", text: "", tool: a.tool, callID, input, status: "running" }]
  }
  return [...entries, { ...base, kind: "text", text: a.text, tool: "" }]
}

function sameActivityScope(
  left: Pick<ExpertPhaseEntry, "sessionID" | "phase" | "subsystem">,
  right: Pick<ExpertPhaseEntry, "sessionID" | "phase" | "subsystem">,
): boolean {
  return (
    left.sessionID === right.sessionID && left.phase === right.phase && sameSubsystem(left.subsystem, right.subsystem)
  )
}

function sameSubsystem(left: SubsystemDescriptor, right: SubsystemDescriptor): boolean {
  return left.name === right.name && left.version === right.version && left.label === right.label
}
