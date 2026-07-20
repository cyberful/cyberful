// ── Sequential Workflow Orchestrator ──────────────────────────────
// Advances any registered Codex-owned workflow through validated handoffs,
// preserving one process and one private gateway at a time.
// → cyberful/src/subsystem/phase-runner.ts — owns each phase process lifecycle.
// ─────────────────────────────────────────────────────────────────

import { Effect } from "effect"
import { SubsystemPhase } from "./phase"
import type { PhaseSpec, PhaseResult } from "./phase-runner"
import { SessionReportLog } from "@/session/report-log"
import type { SessionID } from "@/session/schema"
import type { Candidate as CompletionCandidate } from "./completion"
import type { RunTermination } from "./cli"
import type { SubsystemFallback } from "./fallback"

export interface AdvanceInput {
  sessionID: SessionID
  // The Expert phase the session is currently on (lastUser.agent).
  startPhase: string
  // The engagement objective / prior handoff brief seeding the first phase.
  objective: string
  workareaCwd: string
  // Namespace for semantic phase names and their gateway capability policy.
  workflow: string
  sourceRoot?: string
  home: string
  path: { cwd: string; root: string }
  // Codex model identity for phase runs. Effort is private Codex application policy.
  expertModel?: string
  expertBackend?: string
  // Immutable launch-directory resolution shared by every phase in this run.
  fallback?: SubsystemFallback.Resolution
  timeoutMs: number
  // Private gateway environment; never forwarded to the Codex process.
  env?: Record<string, string>
  // A warning from an earlier phase remains visible in the terminal result.
  degraded?: boolean
}

export interface AdvanceDeps {
  runPhase: (spec: PhaseSpec) => Promise<PhaseResult>
}

export interface AdvanceOutcome {
  ranPhases: string[]
  handedTo?: string
  // Set when a phase failed its deliverable/process/handoff gate. No successor was started.
  haltedAt?: string
  // true when the run ended on its workflow's terminal Expert phase: no successor, the engagement ends.
  terminal: boolean
  status: "completed" | "completed_with_warnings"
  summary: string
  termination?: RunTermination
  completion?: CompletionCandidate
}

// ── Handoffs Seed The Successor Without Copying A Transcript ─────────
// A successor receives the prior summary for orientation and reads workarea
// artifacts for complete evidence. The summary is therefore bounded before it
// enters the next prompt, preventing verbose output or an accidental stream dump
// from consuming that phase's context. Truncation remains explicit and directs
// the successor to the durable source rather than silently dropping detail.
// ──────────────────────────────────────────────────────────────
const SUMMARY_CAP = 6000
function capSummary(text: string): string {
  return text.length <= SUMMARY_CAP
    ? text
    : text.slice(0, SUMMARY_CAP) + "\n…(summary truncated — read the workarea for the full detail)"
}

function rejectedPhase(phase: string, input: AdvanceInput, error: unknown): PhaseResult {
  const limitMs = input.timeoutMs > 0 ? input.timeoutMs : SubsystemPhase.DEFAULT_PHASE_BUDGET_MINUTES * 60_000
  const now = Date.now()
  const detail = error instanceof Error ? error.message : String(error)
  return {
    phase,
    ok: false,
    summary: `The ${phase} phase runner failed before returning a result: ${detail}`,
    exitCode: 1,
    timedOut: false,
    termination: "provider_failed",
    backend: input.expertBackend ?? "unknown",
    durationMs: 0,
    limitMs,
    effectiveLimitMs: limitMs,
    deadlineAt: now + limitMs,
    warnings: [`Expert phase runner rejected before returning a result: ${detail}`],
  }
}

export const runAndAdvance = Effect.fn("Expert.runAndAdvance")(function* (input: AdvanceInput, deps: AdvanceDeps) {
  let phase = input.startPhase
  let objective = input.objective
  let lastSummary = ""
  let degraded = input.degraded === true
  const ranPhases: string[] = []
  let acceptedHandoff = false

  while (SubsystemPhase.isExpertPhase(input.workflow, phase)) {
    const result = yield* Effect.promise((abort) =>
      deps
        .runPhase({
          phase,
          workflow: input.workflow,
          sessionID: input.sessionID,
          workareaCwd: input.workareaCwd,
          sourceRoot: input.sourceRoot,
          home: input.home,
          objective,
          model: input.expertModel,
          fallback: input.fallback,
          timeoutMs: input.timeoutMs,
          abort,
          env: input.env,
          handoff: { successor: SubsystemPhase.nextAfterExpertPhase(input.workflow, phase) },
          transcriptPath: SessionReportLog.expertTranscriptFile(
            { directory: input.path.cwd, worktree: input.path.root },
            input.sessionID,
            phase,
            input.workflow,
          ),
        })
        .catch((error) => rejectedPhase(phase, input, error)),
    )
    ranPhases.push(phase)
    degraded ||= !result.ok || result.warnings.length > 0
    lastSummary = capSummary(result.summary.trim()) || `(the ${phase} phase produced no textual summary)`
    acceptedHandoff =
      result.ok &&
      result.handoff !== undefined &&
      result.handoff.successor === SubsystemPhase.nextAfterExpertPhase(input.workflow, phase)
    if (!acceptedHandoff) {
      lastSummary =
        `[Expert phase completed_with_warnings: ${result.termination}; exit ${result.exitCode}. ` +
        `No successor was started.]\n${lastSummary}`
    }

    const next = SubsystemPhase.nextAfterExpertPhase(input.workflow, phase)
    if (!acceptedHandoff)
      return {
        ranPhases,
        haltedAt: phase,
        terminal: false,
        status: "completed_with_warnings",
        summary: lastSummary,
        termination: result.termination,
      } satisfies AdvanceOutcome

    if (!next)
      return {
        ranPhases,
        terminal: true,
        status: degraded ? "completed_with_warnings" : "completed",
        summary: lastSummary,
        completion: result.handoff?.completion,
      } satisfies AdvanceOutcome

    if (!SubsystemPhase.isExpertPhase(input.workflow, next)) {
      return {
        ranPhases,
        haltedAt: phase,
        terminal: false,
        status: "completed_with_warnings",
        summary: `Invalid Codex-only successor '${next}' after '${phase}'. No successor was started.\n${lastSummary}`,
      } satisfies AdvanceOutcome
    }

    // ── A Validated Handoff Cannot Overlap Its Successor ────────────
    // The gateway records a requested successor, but the orchestrator advances
    // only after runPhase has validated that request and completed its lifecycle.
    // At this point the old Codex process and private gateway are both gone.
    // Assigning the next phase here therefore preserves single-phase ownership,
    // including when the prior phase needed forced shutdown or cleanup warnings.
    // ──────────────────────────────────────────────────────────────
    phase = next
    objective = `The prior Expert phase (${ranPhases[ranPhases.length - 1]}) produced:\n${lastSummary}\n\nNow carry out the ${next} phase to completion.`
  }

  return {
    ranPhases,
    handedTo: phase,
    terminal: false,
    status: degraded ? "completed_with_warnings" : "completed",
    summary: lastSummary,
  } satisfies AdvanceOutcome
})

export * as SubsystemOrchestrator from "./orchestrator"
