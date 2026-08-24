// ── Coding-Agent Session Inspection ─────────────────────────────
// Aggregates restart-safe workflow facts into one redacted public snapshot.
// Live connection state is supplied by the serving control plane; durable
// artifacts remain authoritative for phase, findings, usage, and cleanup.
// → cyberful/src/server/routes/instance/httpapi/handlers/session.ts — binds the snapshot to HTTP.
// → cyberful/src/cli/observation.ts — wraps snapshots in the public JSONL wire.
// @docs/user-guide/cyberful-skill.md
// ─────────────────────────────────────────────────────────────────

import { Schema } from "effect"
import { FindingRegistry } from "@/finding/registry"
import { Global } from "@/global"
import { ApprovalMailbox } from "@/question/mailbox"
import { readHypothesisRegistryView } from "@/subsystem/gateway/hypothesis-registry"
import { readProviderUsageView } from "@/subsystem/provider-usage"
import { readWorkareaFileChunk } from "@/workarea"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionHypothesis } from "./hypothesis"
import { SessionProviderUsage } from "./provider-usage"
import { SessionStatus } from "./status"

const IsoTimestamp = Schema.String
const CountMap = Schema.Record(Schema.String, Schema.Number)
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

export const Diagnostic = Schema.Struct({
  component: Schema.String,
  code: Schema.String,
  message: Schema.String,
}).annotate({ identifier: "SessionInspectionDiagnostic" })

export const Actor = Schema.Struct({
  id: Schema.String,
  parentID: Schema.optional(Schema.String),
  recoveryOf: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  status: Schema.Literals(["running", "completed", "failed"]),
  lastActivityAt: IsoTimestamp,
  toolCalls: Schema.Number,
  termination: Schema.optional(Schema.String),
}).annotate({ identifier: "SessionInspectionActor" })

export const Retry = Schema.Struct({
  runID: Schema.String,
  state: Schema.String,
  attempt: Schema.Number,
  attemptTimeoutMs: Schema.optional(Schema.Number),
  retryWaitMs: Schema.optional(Schema.Number),
  compensationMs: Schema.optional(Schema.Number),
  deadlineAt: Schema.optional(IsoTimestamp),
  compensationCapReached: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "SessionInspectionRetry" })

export const Recovery = Schema.Struct({
  chainID: Schema.String,
  runID: Schema.String,
  recoveryRunID: Schema.optional(Schema.String),
  scope: Schema.String,
  cause: Schema.String,
  state: Schema.String,
  sourceRoute: Schema.String,
  destinationRoute: Schema.optional(Schema.String),
  quotaExempt: Schema.Boolean,
  bonusMs: Schema.Number,
  availableRuntimeMs: Schema.Number,
  availableOutputTokens: Schema.optional(Schema.Number),
  deadlineAt: Schema.optional(IsoTimestamp),
  denialCode: Schema.optional(Schema.String),
  termination: Schema.optional(Schema.String),
  terminationCause: Schema.optional(Schema.String),
  updatedAt: IsoTimestamp,
}).annotate({ identifier: "SessionInspectionRecovery" })

export const Steering = Schema.Struct({
  id: Schema.String,
  runID: Schema.String,
  mode: Schema.String,
  state: Schema.String,
  acceptedAt: IsoTimestamp,
  appliedAt: Schema.optional(IsoTimestamp),
  reason: Schema.optional(Schema.String),
  updatedAt: IsoTimestamp,
}).annotate({ identifier: "SessionInspectionSteering" })

export const Cleanup = Schema.Struct({
  state: Schema.Literals(["completed", "failed"]),
  removed: Schema.Array(Schema.String),
  remaining: Schema.Array(Schema.String),
  completedAt: IsoTimestamp,
}).annotate({ identifier: "SessionInspectionCleanup" })

export const Lifecycle = Schema.Struct({
  version: Schema.Literal(2),
  workflow: Schema.String,
  phase: Schema.String,
  attempt: Schema.Number,
  status: Schema.String,
  mode: Schema.Literals(["work", "closeout"]),
  termination: Schema.optional(Schema.String),
  sessionStatus: Schema.optional(Schema.Literals(["closed", "closed_with_cleanup_errors"])),
  sessionOutcome: Schema.optional(Schema.Literals(["success", "warning", "blocked", "failed"])),
  deadlineAt: IsoTimestamp,
  budgetRemainingMs: Schema.Number,
  closeoutReserveMs: Schema.Number,
  closeoutRemainingMs: Schema.Number,
  approvalWaitMs: Schema.optional(Schema.Number),
  humanWaitMs: Schema.optional(Schema.Number),
  retryWaitMs: Schema.optional(Schema.Number),
  providerWaitMs: Schema.optional(Schema.Number),
  targetCooldownWaitMs: Schema.optional(Schema.Number),
  retryCompensationMs: Schema.optional(Schema.Number),
  phaseExtensionMs: Schema.optional(Schema.Number),
  recoveryExtensionMs: Schema.optional(Schema.Number),
  lastProgressAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  freshnessMs: Schema.Number,
  retry: Schema.optional(Retry),
  recoveries: Schema.Array(Recovery),
  steering: Schema.Array(Steering),
  cleanup: Schema.optional(Cleanup),
}).annotate({ identifier: "SessionInspectionLifecycle" })

export const Actors = Schema.Struct({
  running: Schema.Number,
  completed: Schema.Number,
  failed: Schema.Number,
  total: Schema.Number,
  active: Schema.Array(Actor),
}).annotate({ identifier: "SessionInspectionActors" })

export const Finding = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  phase: Schema.String,
  review: Schema.Literals(["IN_REVIEW", "ASSESSED"]),
  technicalState: Schema.optional(Schema.String),
  severity: Schema.String,
  summary: Schema.String,
  evidencePaths: Schema.Array(Schema.String),
  verification: Schema.String,
  submission: Schema.String,
  updatedAt: IsoTimestamp,
}).annotate({ identifier: "SessionInspectionFinding" })

export const Findings = Schema.Struct({
  revision: Schema.Number,
  total: Schema.Number,
  currentCount: Schema.Number,
  countsByState: CountMap,
  current: Schema.Array(Finding),
}).annotate({ identifier: "SessionInspectionFindings" })

export const Hypothesis = Schema.Struct({
  id: Schema.String,
  phase: Schema.String,
  owner: Schema.String,
  ownerDisplayName: Schema.optional(Schema.String),
  description: Schema.String,
  state: Schema.String,
  blocker: Schema.optional(Schema.String),
  blockerReason: Schema.optional(Schema.String),
  nextStep: Schema.optional(Schema.String),
  findingID: Schema.optional(Schema.String),
}).annotate({ identifier: "SessionInspectionHypothesis" })

export const Hypotheses = Schema.Struct({
  revision: Schema.Number,
  activeCount: Schema.Number,
  countsByState: CountMap,
  active: Schema.Array(Hypothesis),
}).annotate({ identifier: "SessionInspectionHypotheses" })

export const ApprovalQuestion = Schema.Struct({
  question: Schema.String,
  header: Schema.String,
  options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
  multiple: Schema.optional(Schema.Boolean),
  custom: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "SessionInspectionApprovalQuestion" })

export const Approval = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  active: Schema.Boolean,
  createdAt: IsoTimestamp,
  questions: Schema.Array(ApprovalQuestion),
}).annotate({ identifier: "SessionInspectionApproval" })

export const Completion = Schema.Struct({
  workflow: Schema.String,
  outcome: Schema.Literals(["success", "warning", "blocked", "failed"]),
  title: Schema.String,
  summaryMarkdown: Schema.String,
  workarea: Schema.optional(Schema.String),
  artifacts: Schema.Array(MessageV2.CompletionArtifact),
  nextWorkflow: Schema.optional(Schema.String),
  startedPhase: Schema.optional(Schema.String),
  lastPhase: Schema.optional(Schema.String),
  ranPhases: Schema.optional(Schema.Array(Schema.String)),
  failure: Schema.optional(MessageV2.CompletionFailure),
}).annotate({ identifier: "SessionInspectionCompletion" })

export const Source = Schema.Struct({
  mode: Schema.Literals(["live", "durable"]),
  connection: Schema.Literals(["connected", "not-attached"]),
  reliable: Schema.Boolean,
  status: Schema.optional(SessionStatus.Info),
}).annotate({ identifier: "SessionInspectionSource" })

export const SessionInspectionV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generatedAt: IsoTimestamp,
  source: Source,
  session: Session.Info,
  lifecycle: Schema.optional(Lifecycle),
  actors: Actors,
  findings: Schema.optional(Findings),
  hypotheses: Schema.optional(Hypotheses),
  providerUsage: Schema.optional(
    Schema.Struct({ root: SessionProviderUsage.Totals, subagents: SessionProviderUsage.Totals }),
  ),
  approvals: Schema.Array(Approval),
  completion: Schema.optional(Completion),
  diagnostics: Schema.Array(Diagnostic),
}).annotate({ identifier: "SessionInspectionV1" })

export type SessionInspectionV1 = typeof SessionInspectionV1.Type
export type SessionInspectionDiagnostic = typeof Diagnostic.Type

const RawActor = Schema.Struct({
  id: Schema.String,
  parent_id: Schema.optional(Schema.String),
  recovery_of: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  status: Schema.Literals(["running", "completed", "failed"]),
  last_activity_at: Schema.String,
  tool_calls: Schema.Number,
  termination: Schema.optional(Schema.String),
})

const RawRetry = Schema.Struct({
  run_id: Schema.String,
  state: Schema.String,
  attempt: Schema.Number,
  attempt_timeout_ms: Schema.optional(Schema.Number),
  retry_wait_ms: Schema.optional(Schema.Number),
  compensation_ms: Schema.optional(Schema.Number),
  deadline_at: Schema.optional(Schema.String),
  compensation_cap_reached: Schema.optional(Schema.Boolean),
})

const RawRecovery = Schema.Struct({
  chain_id: Schema.String,
  run_id: Schema.String,
  recovery_run_id: Schema.optional(Schema.String),
  scope: Schema.String,
  cause: Schema.String,
  state: Schema.String,
  source_route: Schema.String,
  destination_route: Schema.optional(Schema.String),
  quota_exempt: Schema.Boolean,
  bonus_ms: Schema.Number,
  available_runtime_ms: Schema.Number,
  available_output_tokens: Schema.optional(Schema.Number),
  deadline_at: Schema.optional(Schema.String),
  denial_code: Schema.optional(Schema.String),
  termination: Schema.optional(Schema.String),
  termination_cause: Schema.optional(Schema.String),
  updated_at: Schema.String,
})

const RawSteering = Schema.Struct({
  id: Schema.String,
  run_id: Schema.String,
  mode: Schema.String,
  state: Schema.String,
  accepted_at: Schema.String,
  applied_at: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  updated_at: Schema.String,
})

const RawCleanup = Schema.Struct({
  state: Schema.Literals(["completed", "failed"]),
  removed: Schema.Array(Schema.String),
  remaining: Schema.Array(Schema.String),
  completed_at: Schema.String,
})

const RawLifecycle = Schema.Struct({
  version: Schema.Literal(2),
  workflow: Schema.String,
  phase: Schema.String,
  attempt: Schema.Number,
  status: Schema.String,
  mode: Schema.Literals(["work", "closeout"]),
  termination: Schema.optional(Schema.String),
  session_status: Schema.optional(Schema.Literals(["closed", "closed_with_cleanup_errors"])),
  session_outcome: Schema.optional(Schema.Literals(["success", "warning", "blocked", "failed"])),
  deadline_at: Schema.String,
  budget_remaining_ms: Schema.Number,
  closeout_reserve_ms: Schema.Number,
  closeout_remaining_ms: Schema.Number,
  approval_wait_ms: Schema.optional(Schema.Number),
  human_wait_ms: Schema.optional(Schema.Number),
  retry_wait_ms: Schema.optional(Schema.Number),
  provider_wait_ms: Schema.optional(Schema.Number),
  target_cooldown_wait_ms: Schema.optional(Schema.Number),
  retry_compensation_ms: Schema.optional(Schema.Number),
  phase_extension_ms: Schema.optional(Schema.Number),
  recovery_extension_ms: Schema.optional(Schema.Number),
  last_progress_at: Schema.String,
  updated_at: Schema.String,
  actors: Schema.Array(RawActor),
  retry: Schema.optional(RawRetry),
  recoveries: Schema.Array(RawRecovery),
  steering: Schema.Array(RawSteering),
  cleanup: Schema.optional(RawCleanup),
})

type RawLifecycle = typeof RawLifecycle.Type

export interface BuildSessionInspectionInput {
  readonly session: Session.Info
  readonly messages: readonly MessageV2.WithParts[]
  readonly workarea?: { readonly root: string; readonly name: string }
  readonly liveStatus?: SessionStatus.Info
  readonly now?: () => Date
  readonly approvalRoot?: string
}

function diagnostic(component: string, code: string, _error: unknown): SessionInspectionDiagnostic {
  return {
    component,
    code,
    message: `The ${component} data is missing, invalid, or unavailable.`,
  }
}

function defined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T
}

function isoTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return
  if (!ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("inspection timestamp is invalid")
  return value
}

function projectLifecycle(raw: RawLifecycle, now: Date): { lifecycle: typeof Lifecycle.Type; actors: typeof Actors.Type } {
  const actors = raw.actors.map((actor) =>
    defined({
      id: actor.id,
      parentID: actor.parent_id,
      recoveryOf: actor.recovery_of,
      role: actor.role,
      provider: actor.provider,
      model: actor.model,
      status: actor.status,
      lastActivityAt: isoTimestamp(actor.last_activity_at)!,
      toolCalls: actor.tool_calls,
      termination: actor.termination,
    }),
  )
  const counts = (status: "running" | "completed" | "failed") => actors.filter((actor) => actor.status === status).length
  const lifecycle = Schema.decodeUnknownSync(Lifecycle)(
    defined({
      version: 2 as const,
      workflow: raw.workflow,
      phase: raw.phase,
      attempt: raw.attempt,
      status: raw.status,
      mode: raw.mode,
      termination: raw.termination,
      sessionStatus: raw.session_status,
      sessionOutcome: raw.session_outcome,
      deadlineAt: isoTimestamp(raw.deadline_at)!,
      budgetRemainingMs: raw.budget_remaining_ms,
      closeoutReserveMs: raw.closeout_reserve_ms,
      closeoutRemainingMs: raw.closeout_remaining_ms,
      approvalWaitMs: raw.approval_wait_ms,
      humanWaitMs: raw.human_wait_ms,
      retryWaitMs: raw.retry_wait_ms,
      providerWaitMs: raw.provider_wait_ms,
      targetCooldownWaitMs: raw.target_cooldown_wait_ms,
      retryCompensationMs: raw.retry_compensation_ms,
      phaseExtensionMs: raw.phase_extension_ms,
      recoveryExtensionMs: raw.recovery_extension_ms,
      lastProgressAt: isoTimestamp(raw.last_progress_at)!,
      updatedAt: isoTimestamp(raw.updated_at)!,
      freshnessMs: Math.max(0, now.getTime() - Date.parse(raw.updated_at)),
      retry: raw.retry
        ? defined({
            runID: raw.retry.run_id,
            state: raw.retry.state,
            attempt: raw.retry.attempt,
            attemptTimeoutMs: raw.retry.attempt_timeout_ms,
            retryWaitMs: raw.retry.retry_wait_ms,
            compensationMs: raw.retry.compensation_ms,
            deadlineAt: isoTimestamp(raw.retry.deadline_at),
            compensationCapReached: raw.retry.compensation_cap_reached,
          })
        : undefined,
      recoveries: raw.recoveries.map((recovery) =>
        defined({
          chainID: recovery.chain_id,
          runID: recovery.run_id,
          recoveryRunID: recovery.recovery_run_id,
          scope: recovery.scope,
          cause: recovery.cause,
          state: recovery.state,
          sourceRoute: recovery.source_route,
          destinationRoute: recovery.destination_route,
          quotaExempt: recovery.quota_exempt,
          bonusMs: recovery.bonus_ms,
          availableRuntimeMs: recovery.available_runtime_ms,
          availableOutputTokens: recovery.available_output_tokens,
          deadlineAt: isoTimestamp(recovery.deadline_at),
          denialCode: recovery.denial_code,
          termination: recovery.termination,
          terminationCause: recovery.termination_cause,
          updatedAt: isoTimestamp(recovery.updated_at)!,
        }),
      ),
      steering: raw.steering.map((steering) =>
        defined({
          id: steering.id,
          runID: steering.run_id,
          mode: steering.mode,
          state: steering.state,
          acceptedAt: isoTimestamp(steering.accepted_at)!,
          appliedAt: isoTimestamp(steering.applied_at),
          reason: steering.reason,
          updatedAt: isoTimestamp(steering.updated_at)!,
        }),
      ),
      cleanup: raw.cleanup
        ? {
            state: raw.cleanup.state,
            removed: [...raw.cleanup.removed],
            remaining: [...raw.cleanup.remaining],
            completedAt: isoTimestamp(raw.cleanup.completed_at)!,
          }
        : undefined,
    }),
  )
  const actorView = Schema.decodeUnknownSync(Actors)({
      running: counts("running"),
      completed: counts("completed"),
      failed: counts("failed"),
      total: actors.length,
      active: actors.filter((actor) => actor.status === "running"),
  })
  return { lifecycle, actors: actorView }
}

async function readLifecycle(workareaRoot: string, now: Date) {
  const chunk = await readWorkareaFileChunk(workareaRoot, "raw/operations/run-state.json")
  if (chunk.nextOffset !== undefined) throw new Error("run-state artifact exceeds the 64 KiB inspection boundary")
  const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(RawLifecycle))(chunk.content)
  return projectLifecycle(decoded, now)
}

function projectFindings(view: FindingRegistry.View): typeof Findings.Type {
  const current = view.registry.findings.flatMap((finding) => {
    const observation = finding.observations.findLast((candidate) => candidate.runID === view.runID)
    if (!observation) return []
    const technicalState = observation.review === "ASSESSED" ? observation.disposition.state : observation.carriedState
    return [
      defined({
        id: finding.id,
        title: finding.title,
        phase: observation.phase,
        review: observation.review,
        technicalState,
        severity: observation.severity,
        summary: observation.summary,
        evidencePaths: [...observation.evidencePaths],
        verification: observation.verification.result,
        submission: observation.submission.result,
        updatedAt: isoTimestamp(finding.updatedAt)!,
      }),
    ]
  })
  const countsByState: Record<string, number> = {}
  for (const finding of current) {
    const state = finding.technicalState ?? finding.review
    countsByState[state] = (countsByState[state] ?? 0) + 1
  }
  return Schema.decodeUnknownSync(Findings)({
    revision: view.registry.revision,
    total: view.registry.findings.length,
    currentCount: current.length,
    countsByState,
    current,
  })
}

function projectHypotheses(view: SessionHypothesis.View): typeof Hypotheses.Type {
  return Schema.decodeUnknownSync(Hypotheses)({
    revision: view.revision,
    activeCount: view.activeCount,
    countsByState: { ...view.countsByState },
    active: view.activeHypotheses.map((item) =>
      defined({
        id: item.id,
        phase: item.phase,
        owner: item.owner,
        ownerDisplayName: item.ownerDisplayName,
        description: item.description,
        state: item.state,
        blocker: item.blocker,
        blockerReason: item.blockerReason,
        nextStep: item.nextStep,
        findingID: item.findingID,
      }),
    ),
  })
}

function latestCompletion(messages: readonly MessageV2.WithParts[]): typeof Completion.Type | undefined {
  const part = messages
    .flatMap((message) => message.parts)
    .findLast((candidate): candidate is MessageV2.CompletionPart => candidate.type === "completion")
  if (!part) return
  return defined({
    workflow: part.workflow,
    outcome: part.outcome,
    title: part.title,
    summaryMarkdown: part.summaryMarkdown,
    workarea: part.workarea,
    artifacts: [...part.artifacts],
    nextWorkflow: part.nextWorkflow,
    startedPhase: part.startedPhase,
    lastPhase: part.lastPhase,
    ranPhases: part.ranPhases ? [...part.ranPhases] : undefined,
    failure: part.failure,
  })
}

// ── Partial Persistence Produces Diagnostics, Not Fiction ────────
// A session can be inspected before its first workarea exists, after a restart,
// or while a writer replaces an artifact. Each independent source is therefore
// collected separately. A failed component is omitted and named in diagnostics;
// the remaining structured facts stay usable without being promoted to truth.
// ─────────────────────────────────────────────────────────────────
export async function buildSessionInspection(input: BuildSessionInspectionInput): Promise<SessionInspectionV1> {
  const now = input.now?.() ?? new Date()
  const diagnostics: SessionInspectionDiagnostic[] = []
  let lifecycle: typeof Lifecycle.Type | undefined
  let actors: typeof Actors.Type = { running: 0, completed: 0, failed: 0, total: 0, active: [] }
  let findings: typeof Findings.Type | undefined
  let hypotheses: typeof Hypotheses.Type | undefined
  let providerUsage: SessionInspectionV1["providerUsage"]

  if (!input.workarea) {
    diagnostics.push({
      component: "workarea",
      code: "not-available",
      message: "The session has not published a durable workarea yet.",
    })
  } else {
    try {
      const projection = await readLifecycle(input.workarea.root, now)
      lifecycle = projection.lifecycle
      actors = projection.actors
    } catch (error) {
      diagnostics.push(diagnostic("lifecycle", "not-available", error))
    }
    try {
      findings = projectFindings(await new FindingRegistry.Store(input.workarea.root, { workarea: input.workarea.name }).view(input.session.id))
    } catch (error) {
      diagnostics.push(diagnostic("findings", "not-available", error))
    }
    if (!input.session.workflow) {
      diagnostics.push({ component: "hypotheses", code: "workflow-missing", message: "The session has no workflow." })
    } else {
      try {
        hypotheses = projectHypotheses(await readHypothesisRegistryView(input.workarea.root, input.session.workflow))
      } catch (error) {
        diagnostics.push(diagnostic("hypotheses", "not-available", error))
      }
    }
    try {
      const usage = await readProviderUsageView(input.workarea.root, input.session.id)
      providerUsage = { root: usage.root, subagents: usage.subagents }
    } catch (error) {
      diagnostics.push(diagnostic("providerUsage", "not-available", error))
    }
  }

  let approvals: Array<typeof Approval.Type> = []
  try {
    approvals = (await ApprovalMailbox.make(input.approvalRoot ?? Global.Path.state).list())
      .filter((request) => request.sessionID === input.session.id)
      .map((request) => ({
        id: request.id,
        sessionID: request.sessionID,
        active: request.active,
        createdAt: new Date(request.createdAt).toISOString(),
        questions: request.questions.map((question) => ({
          question: question.question,
          header: question.header,
          options: question.options.map((option) => ({ ...option })),
          ...(question.multiple === undefined ? {} : { multiple: question.multiple }),
          ...(question.custom === undefined ? {} : { custom: question.custom }),
        })),
      }))
  } catch (error) {
    diagnostics.push(diagnostic("approvals", "not-available", error))
  }

  const inspection = defined({
    schemaVersion: 1 as const,
    generatedAt: now.toISOString(),
    source: input.liveStatus
      ? { mode: "live" as const, connection: "connected" as const, reliable: true, status: input.liveStatus }
      : { mode: "durable" as const, connection: "not-attached" as const, reliable: false },
    session: input.session,
    lifecycle,
    actors,
    findings,
    hypotheses,
    providerUsage,
    approvals,
    completion: latestCompletion(input.messages),
    diagnostics,
  })
  return Schema.decodeUnknownSync(SessionInspectionV1)(inspection)
}

export * as SessionInspection from "./inspection"
