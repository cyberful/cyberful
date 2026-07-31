// ── Expert Phase Feed Model ──────────────────────────────────────
// Decodes public phase status and activity, merges tool calls with their later
//   results, and folds readable turns without depending on SolidJS or rendering.
// → cyberful/src/cli/cmd/tui/context/sync.tsx — stores the folded live feed.
// ─────────────────────────────────────────────────────────────────

import type {
  PhaseActivityActor,
  PhaseActivityActorState,
  PhaseActivityArtifact,
  SubsystemDescriptor,
} from "@/session/event"
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
  artifact?: PhaseActivityArtifact
  status?: "running" | "completed"
  phaseStatus?: ExpertPhaseStatus
  contextCompaction?: ExpertContextCompaction
  providerRetry?: ExpertProviderRetry
  runtimeDiagnostic?: ExpertRuntimeDiagnostic
  actor?: PhaseActivityActor
  actorState?: PhaseActivityActorState
  actorTransitionID?: string
  delegation?: ExpertDelegation
}

export type ExpertDelegation = {
  actor: PhaseActivityActor
  state: PhaseActivityActorState
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
  failure?: {
    phase: string
    source: string
    class: string
    code?: string
    detail: string
  }
  warnings: string[]
  handoff?: {
    successor: string
  }
}

export type ExpertContextCompaction = {
  state: "completed" | "noop" | "recovered" | "failed"
  mode: "proactive" | "emergency"
  reason?: string
  estimatedTokensBefore: number
  estimatedTokensAfter: number
  messagesRemoved: number
  toolResultsVirtualized: number
  artifactsPreserved: number
  modelSummary: boolean
  summaryArtifact?: string
  detail?: string
}

export type ExpertProviderRetry = {
  state: "scheduled" | "attempting" | "succeeded" | "timed_out" | "exhausted" | "cancelled"
  attempt: number
  maxRetries: number
  delayMs?: number
  providerCode?: string
}

export type ExpertRuntimeDiagnostic = {
  component: "gateway" | "zap" | "browser" | "mcp"
  profile?: string
  stage: "startup" | "connect" | "tool" | "shutdown"
  severity: "warning" | "error"
  errorClass: string
  code?: string
  message: string
  path: string
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

export function expertActorIdentityText(actor: PhaseActivityActor | undefined): string | undefined {
  return actor?.displayName && actor.emoji ? `${actor.emoji} ${actor.displayName}` : undefined
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

export function decodeExpertContextCompaction(text: string): ExpertContextCompaction | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value) || !isRecord(value.contextCompaction)) return
    const compaction = value.contextCompaction
    if (
      !["completed", "noop", "recovered", "failed"].includes(String(compaction.state)) ||
      !["proactive", "emergency"].includes(String(compaction.mode)) ||
      typeof compaction.estimatedTokensBefore !== "number" ||
      typeof compaction.estimatedTokensAfter !== "number" ||
      typeof compaction.messagesRemoved !== "number" ||
      typeof compaction.toolResultsVirtualized !== "number" ||
      typeof compaction.artifactsPreserved !== "number" ||
      (compaction.modelSummary !== undefined && typeof compaction.modelSummary !== "boolean")
    )
      return
    return {
      ...(compaction as Omit<ExpertContextCompaction, "modelSummary">),
      modelSummary: compaction.modelSummary === true,
    }
  } catch {
    return
  }
}

export function decodeExpertProviderRetry(text: string): ExpertProviderRetry | undefined {
  const match = text.match(
    /^Provider retry (scheduled|attempting|succeeded|timed_out|exhausted|cancelled): attempt (\d+)\/(\d+)(?: after (\d+) ms)?(?: \(([^)]+)\))?\.$/,
  )
  if (!match) return
  const state = match[1] as ExpertProviderRetry["state"]
  const attempt = Number(match[2])
  const maxRetries = Number(match[3])
  const delayMs = match[4] === undefined ? undefined : Number(match[4])
  if (!Number.isSafeInteger(attempt) || !Number.isSafeInteger(maxRetries) || attempt < 1 || maxRetries < 1) return
  if (delayMs !== undefined && (!Number.isSafeInteger(delayMs) || delayMs < 0)) return
  return {
    state,
    attempt,
    maxRetries,
    ...(delayMs === undefined ? {} : { delayMs }),
    ...(match[5] ? { providerCode: match[5] } : {}),
  }
}

// ── Runtime Notices Do Not Imply Phase Failure ───────────────────
// The recorder has already sanitized and bounded the detail before publishing
// this host-owned status payload. The feed validates that envelope once, then
// labels tool failures as recoverable because Pi receives the failed call and
// may continue. Legacy path-only rows remain readable after restart, while the
// terminal phase status remains the sole authority for a blocking outcome.
// ─────────────────────────────────────────────────────────────────
export function decodeExpertRuntimeDiagnostic(text: string): ExpertRuntimeDiagnostic | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value) || !isRecord(value.runtimeDiagnostic)) return
    const diagnostic = value.runtimeDiagnostic
    if (
      !["gateway", "zap", "browser", "mcp"].includes(String(diagnostic.component)) ||
      !["startup", "connect", "tool", "shutdown"].includes(String(diagnostic.stage)) ||
      !["warning", "error"].includes(String(diagnostic.severity)) ||
      typeof diagnostic.errorClass !== "string" ||
      typeof diagnostic.message !== "string" ||
      typeof diagnostic.path !== "string" ||
      (diagnostic.profile !== undefined && typeof diagnostic.profile !== "string") ||
      (diagnostic.code !== undefined && typeof diagnostic.code !== "string")
    )
      return
    return diagnostic as ExpertRuntimeDiagnostic
  } catch {
    const legacy = text.match(/^Runtime diagnostic:\s*([^·]+?)\s*·\s*([^·]+?)\s*·\s*(.+)$/u)
    if (!legacy) return
    const component = legacy[1]?.trim()
    if (!component || !["gateway", "zap", "browser", "mcp"].includes(component)) return
    return {
      component: component as ExpertRuntimeDiagnostic["component"],
      stage: "startup",
      severity: "warning",
      errorClass: legacy[2]?.trim() || "RuntimeDiagnostic",
      message: "Sanitized details are available in the local diagnostic log.",
      path: legacy[3]?.trim() || "raw/operations/runtime-diagnostics.jsonl",
    }
  }
}

export function expertRuntimeDiagnosticText(diagnostic: ExpertRuntimeDiagnostic): string {
  const headline =
    diagnostic.stage === "tool"
      ? diagnostic.severity === "error"
        ? "Tool failed; run continues"
        : "Tool warning; run continues"
      : diagnostic.severity === "error"
        ? `Runtime ${diagnostic.stage} error`
        : `Runtime ${diagnostic.stage} notice`
  const source = diagnostic.profile ? `${diagnostic.component}/${diagnostic.profile}` : diagnostic.component
  const code = diagnostic.code ? ` (${diagnostic.code})` : ""
  return (
    `ⓘ ${headline} · ${source} · ${diagnostic.errorClass}${code} · ${diagnostic.message}` + ` · log: ${diagnostic.path}`
  )
}

export function expertContextCompactionText(compaction: ExpertContextCompaction): string {
  const action =
    compaction.state === "completed"
      ? compaction.reason === "target_unreachable"
        ? "Context rotated (target unreachable)"
        : compaction.reason === "context_rotation" || compaction.modelSummary
          ? "Context rotated with model checkpoint"
          : "Context compacted"
      : compaction.state === "noop"
        ? "Context compaction exhausted"
        : compaction.state === "recovered"
          ? "Context recovered"
          : compaction.reason === "model_summary_failed" || compaction.reason === "summary_failed"
            ? "Model context checkpoint failed"
            : compaction.reason === "active_tail_too_large" || compaction.reason === "context_rotation_failed"
              ? "Context rotation failed"
              : "Context compaction failed"
  return [
    `↻ ${action}`,
    `${Locale.number(compaction.estimatedTokensBefore)} → ${Locale.number(compaction.estimatedTokensAfter)} tokens`,
    `${compaction.toolResultsVirtualized} tool results virtualized`,
    `${compaction.artifactsPreserved} complete artifacts preserved`,
  ].join(" · ")
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
      failure: decodeExpertPhaseFailure(value.failure),
      warnings: Array.isArray(value.warnings)
        ? value.warnings.filter((warning): warning is string => typeof warning === "string")
        : [],
      handoff: decodeExpertPhaseHandoff(value.handoff),
    }
  } catch {
    return undefined
  }
}

function decodeExpertPhaseFailure(value: unknown): ExpertPhaseStatus["failure"] {
  if (
    !isRecord(value) ||
    typeof value.phase !== "string" ||
    typeof value.source !== "string" ||
    typeof value.class !== "string" ||
    typeof value.detail !== "string" ||
    (value.code !== undefined && typeof value.code !== "string")
  )
    return undefined
  return {
    phase: value.phase,
    source: value.source,
    class: value.class,
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    detail: value.detail,
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
  const approvalWait = status.approvalWaitMs ? ` · approval wait ${expertPhaseDuration(status.approvalWaitMs)}` : ""
  const warning = status.failure?.detail ?? status.warnings[0]
  const additionalWarnings = status.failure ? status.warnings.length : Math.max(0, status.warnings.length - 1)
  const detail = warning ? ` · ${warning}${additionalWarnings > 0 ? ` (+${additionalWarnings})` : ""}` : ""
  return (
    `Phase failed · ${status.backend} · ${status.termination} · worker exit ${status.exitCode} · ${elapsed}s · ` +
    `limit ${limit}m (effective ${effective}m) · deadline ${new Date(status.deadlineAt).toISOString()}` +
    `${approvalWait}${detail}`
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
// prevents ordinary re-delivery, while provider call identity catches a source
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
    artifact?: PhaseActivityArtifact
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
    if (a.actor.sourceCallID) {
      const index = entries.findIndex(
        (entry) =>
          entry.kind === "tool" &&
          entry.callID === a.actor?.sourceCallID &&
          entry.sessionID === a.sessionID &&
          entry.phase === a.phase &&
          sameSubsystem(entry.subsystem, a.subsystem),
      )
      if (index >= 0) {
        const next = entries.slice()
        next[index] = {
          ...next[index],
          delegation: {
            actor: a.actor,
            state: a.actorState,
          },
        }
        return next
      }
    }
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
    const contextCompaction = decodeExpertContextCompaction(a.text)
    const providerRetry = decodeExpertProviderRetry(a.text)
    const runtimeDiagnostic = decodeExpertRuntimeDiagnostic(a.text)
    return [
      ...entries,
      {
        ...base,
        kind: "status",
        text: status
          ? phaseStatusText(status)
          : contextCompaction
            ? expertContextCompactionText(contextCompaction)
            : runtimeDiagnostic
              ? expertRuntimeDiagnosticText(runtimeDiagnostic)
              : a.text,
        tool: "",
        phaseStatus: status,
        contextCompaction,
        providerRetry,
        runtimeDiagnostic,
      },
    ]
  }
  if (a.kind === "output") {
    const callID = a.tool // an output activity carries the pairing callID in `tool`
    const idx = callID
      ? entries.findIndex((entry) => entry.kind === "tool" && entry.callID === callID && sameActivityScope(entry, a))
      : -1
    if (idx >= 0) {
      const next = entries.slice()
      next[idx] = {
        ...next[idx],
        output: a.text,
        status: "completed",
        ...(a.artifact ? { artifact: a.artifact } : {}),
      }
      return next
    }
    if (entries.some((e) => e.id === a.id)) return entries
    return [
      ...entries,
      {
        ...base,
        kind: "output",
        text: a.text,
        tool: "",
        ...(a.artifact ? { artifact: a.artifact } : {}),
      },
    ]
  }
  if (entries.some((e) => e.id === a.id)) return entries
  if (a.kind === "tool") {
    const { callID, input } = decodeExpertToolActivity(a.text)
    // A provider may redeliver the same tool item through more than one transport notification. Bus
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
