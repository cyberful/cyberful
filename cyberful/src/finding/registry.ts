// ── Workarea Finding Registry ────────────────────────────────────
// Persists structured security findings and per-run observations in one
//   workarea-owned JSON document with atomic, cross-process serialized updates.
// → cyberful/src/session/finding.ts — exposes registry changes to sessions and the TUI.
// → cyberful/src/subsystem/phase-runner.ts — supplies the phase-owned finding tool.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { lstat, readFile, realpath } from "node:fs/promises"
import { Schema } from "effect"
import { Identifier } from "@/id/id"
import { nodeErrorCode } from "@/util/error"
import { Flock } from "@/util/flock"
import { isRecord } from "@/util/record"
import { ensureWorkareaDirectory, replaceWorkareaFile } from "@/workarea"

export const REGISTRY_PATH = "raw/findings/registry.json"

export const Workflow = Schema.Literals(["pentest", "bug-bounty", "code-audit"])
export type Workflow = typeof Workflow.Type

export const TechnicalState = Schema.Literals(["SUSPECTED", "INCONCLUSIVE", "UNTESTABLE", "CONFIRMED", "DISPROVED"])
export type TechnicalState = typeof TechnicalState.Type

export const VerificationResult = Schema.Literals(["NOT_REVIEWED", "SURVIVES", "REVISE", "DEMOTE"])
export type VerificationResult = typeof VerificationResult.Type

export const SubmissionResult = Schema.Literals([
  "NOT_ASSESSED",
  "SUBMISSION_READY",
  "NEEDS_MORE_EVIDENCE",
  "NOT_REPORTABLE",
])
export type SubmissionResult = typeof SubmissionResult.Type

export const Severity = Schema.Literals(["UNRATED", "INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"])
export type Severity = typeof Severity.Type

export const RunStatus = Schema.Literals(["RUNNING", "COMPLETED", "BLOCKED", "FAILED", "INTERRUPTED"])
export type RunStatus = typeof RunStatus.Type

export const SuspectedDisposition = Schema.Struct({
  state: Schema.Literal("SUSPECTED"),
  positiveEvidence: Schema.String,
  nextStep: Schema.optional(Schema.String),
})
export const InconclusiveDisposition = Schema.Struct({
  state: Schema.Literal("INCONCLUSIVE"),
  ambiguity: Schema.String,
  nextStep: Schema.String,
})
export const UntestableDisposition = Schema.Struct({
  state: Schema.Literal("UNTESTABLE"),
  blockerKind: Schema.String,
  blockerReason: Schema.String,
  nextStep: Schema.String,
})
export const ConfirmedDisposition = Schema.Struct({
  state: Schema.Literal("CONFIRMED"),
  proof: Schema.String,
})
export const DisprovedDisposition = Schema.Struct({
  state: Schema.Literal("DISPROVED"),
  reason: Schema.String,
})
export const Disposition = Schema.Union([
  SuspectedDisposition,
  InconclusiveDisposition,
  UntestableDisposition,
  ConfirmedDisposition,
  DisprovedDisposition,
])
export type Disposition = typeof Disposition.Type

export const Decision = <Result extends Schema.Top>(result: Result, identifier: string) =>
  Schema.Struct({
    result,
    rationale: Schema.optional(Schema.String),
  }).annotate({ identifier })

export const Verification = Decision(VerificationResult, "FindingVerification")
export type Verification = typeof Verification.Type
export const Submission = Decision(SubmissionResult, "FindingSubmission")
export type Submission = typeof Submission.Type

const ObservationBase = {
  id: Schema.String,
  runID: Schema.String,
  phase: Schema.String,
  timestamp: Schema.String,
  severity: Severity,
  verification: Verification,
  submission: Submission,
  summary: Schema.String,
  evidencePaths: Schema.Array(Schema.String),
}

export const InReviewObservation = Schema.Struct({
  ...ObservationBase,
  review: Schema.Literal("IN_REVIEW"),
  plan: Schema.String,
  carriedState: Schema.optional(TechnicalState),
})
export const AssessedObservation = Schema.Struct({
  ...ObservationBase,
  review: Schema.Literal("ASSESSED"),
  disposition: Disposition,
})
export const Observation = Schema.Union([InReviewObservation, AssessedObservation])
export type Observation = typeof Observation.Type

export const FindingOrigin = Schema.Struct({
  workflow: Workflow,
  source: Schema.Literals(["finding", "code-graph"]),
  sourceID: Schema.optional(Schema.String),
})

export const Finding = Schema.Struct({
  id: Schema.String,
  aliases: Schema.Array(Schema.String),
  title: Schema.String,
  origin: FindingOrigin,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  observations: Schema.Array(Observation),
}).annotate({ identifier: "WorkareaFinding" })
export type Finding = typeof Finding.Type

export const Run = Schema.Struct({
  id: Schema.String,
  workflow: Workflow,
  startedAt: Schema.String,
  endedAt: Schema.optional(Schema.String),
  status: RunStatus,
}).annotate({ identifier: "FindingRun" })
export type Run = typeof Run.Type

export const Registry = Schema.Struct({
  schema_version: Schema.Literal(1),
  revision: Schema.Number,
  runs: Schema.Array(Run),
  findings: Schema.Array(Finding),
}).annotate({ identifier: "FindingRegistry" })
export type Registry = typeof Registry.Type

export const View = Schema.Struct({
  workarea: Schema.String,
  runID: Schema.String,
  registry: Registry,
}).annotate({ identifier: "FindingRegistryView" })
export type View = typeof View.Type

export interface RunContext {
  readonly runID: string
  readonly workflow: Workflow
  readonly phase: string
}

export interface RegistryOptions {
  readonly workarea: string
  readonly now?: () => Date
  readonly onUpdated?: (revision: number) => void | Promise<void>
}

export interface CodeGraphMirrorFinding {
  readonly id: string
  readonly title: string
  readonly weakness: string
  readonly severity: "critical" | "high" | "medium" | "low" | "info"
  readonly confidence: "confirmed" | "high" | "medium" | "low"
  readonly status: "suspected" | "confirmed" | "dismissed"
  readonly updatedAt: string
  readonly evidence: readonly { readonly description: string }[]
  readonly transitionReason?: string
}

type Mutation<T> = {
  readonly next: Registry
  readonly value: T
  readonly changed: boolean
}

const decodeRegistry = Schema.decodeUnknownSync(Registry)
const workflows = ["pentest", "bug-bounty", "code-audit"] as const
const technicalStates = ["SUSPECTED", "INCONCLUSIVE", "UNTESTABLE", "CONFIRMED", "DISPROVED"] as const
const verificationResults = ["NOT_REVIEWED", "SURVIVES", "REVISE", "DEMOTE"] as const
const submissionResults = ["NOT_ASSESSED", "SUBMISSION_READY", "NEEDS_MORE_EVIDENCE", "NOT_REPORTABLE"] as const
const severities = ["UNRATED", "INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const
const runStatuses = ["RUNNING", "COMPLETED", "BLOCKED", "FAILED", "INTERRUPTED"] as const

const transitions: Readonly<Record<TechnicalState, readonly TechnicalState[]>> = {
  SUSPECTED: technicalStates,
  INCONCLUSIVE: technicalStates,
  UNTESTABLE: technicalStates,
  CONFIRMED: technicalStates,
  DISPROVED: ["DISPROVED", "SUSPECTED"],
}

export class FindingRegistryError extends Error {
  readonly retryable = true

  constructor(
    readonly code: "FINDING_NOT_FOUND" | "FINDING_TRANSITION_INVALID",
    readonly path: string,
    message: string,
    readonly context: {
      readonly revision?: number
      readonly currentState?: string
      readonly requestedState?: string
      readonly allowedStates?: readonly string[]
      readonly availableIDs?: readonly string[]
    },
  ) {
    super(message)
    this.name = "FindingRegistryError"
  }

  toolError(received: unknown) {
    return {
      code: this.code,
      path: this.path,
      expected: "an existing finding id and a permitted advertised state transition",
      receivedType: Array.isArray(received) ? "array" : received === null ? "null" : typeof received,
      retryable: this.retryable,
      hint: this.message,
      ...(this.context.revision === undefined ? {} : { revision: this.context.revision }),
      ...(this.context.currentState ? { current_state: this.context.currentState } : {}),
      ...(this.context.requestedState ? { requested_state: this.context.requestedState } : {}),
      ...(this.context.allowedStates ? { allowed_states: this.context.allowedStates } : {}),
      ...(this.context.availableIDs ? { available_ids: this.context.availableIDs } : {}),
    }
  }
}

function missingFinding(registry: Registry, id: string) {
  return new FindingRegistryError("FINDING_NOT_FOUND", "finding.id", `finding '${id}' does not exist`, {
    revision: registry.revision,
    availableIDs: registry.findings.map((item) => item.id).slice(0, 50),
  })
}

function invalidFindingTransition(input: {
  readonly message: string
  readonly currentState: string
  readonly requestedState: string
  readonly allowedStates: readonly string[]
  readonly revision?: number
  readonly path?: string
}) {
  return new FindingRegistryError(
    "FINDING_TRANSITION_INVALID",
    input.path ?? "finding.state",
    input.message,
    {
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      currentState: input.currentState,
      requestedState: input.requestedState,
      allowedStates: input.allowedStates,
    },
  )
}

function emptyRegistry(): Registry {
  return { schema_version: 1, revision: 0, runs: [], findings: [] }
}

function boundedText(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} must not be empty`)
  if (normalized.length > maximum) throw new Error(`${label} must contain at most ${maximum} characters`)
  if (/\p{Cc}/u.test(normalized)) throw new Error(`${label} must not contain control characters`)
  return normalized
}

function positiveEvidence(value: unknown, label = "finding positive_evidence") {
  if (!Array.isArray(value)) return boundedText(value, label, 8_000)
  if (value.length === 0 || value.length > 32)
    throw new Error(`${label} must be a string or an array of 1 to 32 strings`)
  const normalized = [...new Set(value.map((item, index) => boundedText(item, `${label}[${index}]`, 8_000)))].join("\n")
  if (normalized.length > 8_000) throw new Error(`${label} must contain at most 8000 characters after normalization`)
  return normalized
}

function optionalText(value: unknown, label: string, maximum: number) {
  return value === undefined ? undefined : boundedText(value, label, maximum)
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !values.some((item) => item === value))
    throw new Error(`${label} must be one of ${values.join(", ")}`)
  return value
}

function ratedSeverity(value: unknown) {
  const severity = enumValue(value, severities, "finding severity")
  if (severity === "UNRATED")
    throw new Error("finding severity must be INFO, LOW, MEDIUM, HIGH, or CRITICAL for a new assessment")
  return severity
}

function reference(value: unknown, label: string) {
  const normalized = boundedText(value, label, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(normalized))
    throw new Error(`${label} must use letters, numbers, dot, colon, underscore, or dash`)
  return normalized
}

function evidencePath(value: unknown, label: string) {
  const candidate = boundedText(value, label, 1_024).replaceAll("\\", "/")
  if (path.posix.isAbsolute(candidate) || candidate.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error(`${label} must be a safe workarea-relative path`)
  return candidate
}

function evidencePaths(value: unknown) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("finding evidence_paths must be an array")
  if (value.length > 100) throw new Error("finding evidence_paths must contain at most 100 paths")
  return [...new Set(value.map((item, index) => evidencePath(item, `finding evidence_paths[${index}]`)))]
}

function context(input: RunContext): RunContext {
  return {
    runID: reference(input.runID, "finding run id"),
    workflow: enumValue(input.workflow, workflows, "finding workflow"),
    phase: boundedText(input.phase, "finding phase", 80),
  }
}

function latestAssessed(finding: Finding) {
  return finding.observations.findLast((item): item is typeof AssessedObservation.Type => item.review === "ASSESSED")
}

function findFinding(registry: Registry, value: unknown) {
  const id = reference(value, "finding id or alias")
  return registry.findings.find((item) => item.id === id || item.aliases.includes(id))
}

function decisions(input: Record<string, unknown>, workflow: Workflow, disposition: Disposition) {
  const verificationResult =
    input.verification === undefined
      ? "NOT_REVIEWED"
      : enumValue(input.verification, verificationResults, "finding verification")
  const verificationRationale = optionalText(input.verification_rationale, "finding verification_rationale", 4_000)
  if (verificationResult !== "NOT_REVIEWED" && !verificationRationale)
    throw new Error("finding verification_rationale is required for a verification decision")
  if ((verificationResult === "SURVIVES" || verificationResult === "REVISE") && disposition.state !== "CONFIRMED")
    throw invalidFindingTransition({
      path: "finding.verification",
      currentState: disposition.state,
      requestedState: verificationResult,
      allowedStates: ["CONFIRMED"],
      message: `${verificationResult} requires a CONFIRMED technical state`,
    })
  if (verificationResult === "DEMOTE" && disposition.state === "CONFIRMED")
    throw new Error("DEMOTE must move the technical state away from CONFIRMED")

  const submissionResult =
    input.submission === undefined
      ? "NOT_ASSESSED"
      : enumValue(input.submission, submissionResults, "finding submission")
  const submissionRationale = optionalText(input.submission_rationale, "finding submission_rationale", 4_000)
  if (submissionResult !== "NOT_ASSESSED" && workflow !== "bug-bounty")
    throw new Error("finding submission decisions are available only in Bug Bounty runs")
  if (submissionResult !== "NOT_ASSESSED" && !submissionRationale)
    throw new Error("finding submission_rationale is required for a submission decision")
  if (submissionResult === "SUBMISSION_READY" && disposition.state !== "CONFIRMED")
    throw invalidFindingTransition({
      path: "finding.submission",
      currentState: disposition.state,
      requestedState: submissionResult,
      allowedStates: ["CONFIRMED"],
      message: "SUBMISSION_READY requires a CONFIRMED technical state",
    })

  return {
    verification: {
      result: verificationResult,
      ...(verificationRationale ? { rationale: verificationRationale } : {}),
    },
    submission: {
      result: submissionResult,
      ...(submissionRationale ? { rationale: submissionRationale } : {}),
    },
  }
}

function disposition(input: Record<string, unknown>): Disposition {
  const state = enumValue(input.state, technicalStates, "finding state")
  if (state === "SUSPECTED") {
    const nextStep = optionalText(input.next_step, "finding next_step", 4_000)
    return {
      state,
      positiveEvidence: positiveEvidence(input.positive_evidence),
      ...(nextStep ? { nextStep } : {}),
    }
  }
  if (state === "INCONCLUSIVE")
    return {
      state,
      ambiguity: boundedText(input.ambiguity, "finding ambiguity", 8_000),
      nextStep: boundedText(input.next_step, "finding next_step", 4_000),
    }
  if (state === "UNTESTABLE")
    return {
      state,
      blockerKind: boundedText(input.blocker_kind, "finding blocker_kind", 80),
      blockerReason: boundedText(input.blocker_reason, "finding blocker_reason", 8_000),
      nextStep: boundedText(input.next_step, "finding next_step", 4_000),
    }
  if (state === "CONFIRMED")
    return {
      state,
      proof: boundedText(input.proof, "finding proof", 8_000),
    }
  return {
    state,
    reason: boundedText(input.disproof, "finding disproof", 8_000),
  }
}

function canonicalJson(registry: Registry) {
  return `${JSON.stringify(registry, null, 2)}\n`
}

// ── Historical Evidence Never Becomes Current-Run Proof ─────────
// A finding owns one stable identity, while every run appends its own observation.
// Reading an older disposition may prioritize a revisit, but only an observation
// stamped with the active run can make it current. Revisit therefore records an
// explicit in-review entry and carries the old state only as context. Updates add
// complete assessed snapshots so later readers never reconstruct state from prose.
// ─────────────────────────────────────────────────────────────────
export class Store {
  readonly #root: string
  readonly #workarea: string
  readonly #now: () => Date
  readonly #onUpdated?: RegistryOptions["onUpdated"]

  constructor(workareaRoot: string, options: RegistryOptions) {
    if (!path.isAbsolute(workareaRoot)) throw new Error("finding registry requires an absolute workarea root")
    this.#root = path.resolve(workareaRoot)
    this.#workarea = boundedText(options.workarea, "finding workarea", 160)
    this.#now = options.now ?? (() => new Date())
    this.#onUpdated = options.onUpdated
  }

  get workarea() {
    return this.#workarea
  }

  async read(): Promise<Registry> {
    const root = await realpath(this.#root)
    if (root !== this.#root) throw new Error("finding registry workarea root must already be canonical")
    const file = path.join(root, REGISTRY_PATH)
    const info = await lstat(file).catch((error: unknown) => {
      if (nodeErrorCode(error) === "ENOENT") return undefined
      throw error
    })
    if (!info) return emptyRegistry()
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("finding registry must be a regular file, not a link or special file")
    const canonical = await realpath(file)
    const relative = path.relative(root, canonical)
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("finding registry escapes the canonical workarea")
    if (canonical !== file) throw new Error("finding registry path must not contain symbolic links")

    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(file, "utf8"))
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("finding registry contains invalid JSON", { cause: error })
      throw error
    }
    const decoded = decodeRegistry(parsed)
    if (!Number.isSafeInteger(decoded.revision) || decoded.revision < 0)
      throw new Error("finding registry revision must be a non-negative safe integer")
    return decoded
  }

  async view(runID: string): Promise<View> {
    return {
      workarea: this.#workarea,
      runID: reference(runID, "finding run id"),
      registry: await this.read(),
    }
  }

  async #mutate<T>(apply: (current: Registry) => Mutation<T>, signal?: AbortSignal): Promise<T> {
    let publishedRevision: number | undefined
    const lockDirectory = await ensureWorkareaDirectory(this.#root, "raw/findings/.locks")
    const value = await Flock.withLock(
      `finding-registry:${this.#root}`,
      async () => {
        const current = await this.read()
        const mutation = apply(current)
        if (!mutation.changed) return mutation.value
        const next = { ...mutation.next, revision: current.revision + 1 } satisfies Registry
        await replaceWorkareaFile(this.#root, REGISTRY_PATH, canonicalJson(next), { mode: 0o600 })
        publishedRevision = next.revision
        return mutation.value
      },
      { signal, dir: lockDirectory },
    )
    if (publishedRevision !== undefined) await this.#onUpdated?.(publishedRevision)
    return value
  }

  async startRun(input: { id: string; workflow: Workflow }, signal?: AbortSignal) {
    const id = reference(input.id, "finding run id")
    const workflow = enumValue(input.workflow, workflows, "finding workflow")
    const startedAt = this.#now().toISOString()
    return this.#mutate((current) => {
      const existing = current.runs.find((item) => item.id === id)
      if (existing) {
        if (existing.workflow !== workflow)
          throw new Error(`finding run '${id}' already belongs to ${existing.workflow}`)
        return { next: current, value: existing, changed: false }
      }
      const run = { id, workflow, startedAt, status: "RUNNING" } satisfies Run
      return { next: { ...current, runs: [...current.runs, run] }, value: run, changed: true }
    }, signal)
  }

  async finishRun(input: { id: string; status: Exclude<RunStatus, "RUNNING"> }, signal?: AbortSignal) {
    const id = reference(input.id, "finding run id")
    const status = enumValue(input.status, runStatuses, "finding run status")
    if (status === "RUNNING") throw new Error("finding run completion requires a terminal status")
    const endedAt = this.#now().toISOString()
    return this.#mutate((current) => {
      const existing = current.runs.find((item) => item.id === id)
      if (!existing) throw new Error(`finding run '${id}' does not exist`)
      if (existing.status !== "RUNNING") return { next: current, value: existing, changed: false }
      const run = { ...existing, status, endedAt } satisfies Run
      return {
        next: { ...current, runs: current.runs.map((item) => (item.id === id ? run : item)) },
        value: run,
        changed: true,
      }
    }, signal)
  }

  async execute(value: unknown, runContext: RunContext, signal?: AbortSignal): Promise<unknown> {
    const input = isRecord(value) ? value : {}
    const action = boundedText(input.action, "finding action", 40)
    const active = context(runContext)
    if (action === "list") return this.list(active.runID)
    if (action === "get") return this.get(input.id)
    if (action === "record") return this.record(input, active, signal)
    if (action === "revisit") return this.revisit(input, active, signal)
    if (action === "update") return this.update(input, active, signal)
    if (action === "alias") return this.alias(input, signal)
    throw new Error("finding action must be record, revisit, update, alias, list, or get")
  }

  async list(runID: string) {
    const registry = await this.read()
    const activeRunID = reference(runID, "finding run id")
    return registry.findings.map((finding) => ({
      id: finding.id,
      aliases: finding.aliases,
      title: finding.title,
      origin: finding.origin,
      latest: latestAssessed(finding),
      currentRun: finding.observations.findLast((item) => item.runID === activeRunID),
      historical: !finding.observations.some((item) => item.runID === activeRunID),
      updatedAt: finding.updatedAt,
    }))
  }

  async get(id: unknown) {
    const registry = await this.read()
    const referenceID = reference(id, "finding id or alias")
    const finding = findFinding(registry, referenceID)
    if (!finding) throw missingFinding(registry, referenceID)
    return finding
  }

  async record(input: Record<string, unknown>, runContext: RunContext, signal?: AbortSignal) {
    const key = reference(input.key, "finding key")
    const title = boundedText(input.title, "finding title", 300)
    const evidence = positiveEvidence(input.positive_evidence)
    const nextStep = optionalText(input.next_step, "finding next_step", 4_000)
    const technical: Disposition = {
      state: "SUSPECTED",
      positiveEvidence: evidence,
      ...(nextStep ? { nextStep } : {}),
    }
    const severity = ratedSeverity(input.severity)
    const summary = boundedText(input.summary ?? evidence.replaceAll("\n", " • "), "finding summary", 4_000)
    const paths = evidencePaths(input.evidence_paths)
    const timestamp = this.#now().toISOString()
    const decisionsValue = decisions(input, runContext.workflow, technical)
    const observation = {
      id: Identifier.create("obs", "ascending"),
      runID: runContext.runID,
      phase: runContext.phase,
      timestamp,
      review: "ASSESSED",
      disposition: technical,
      severity,
      ...decisionsValue,
      summary,
      evidencePaths: paths,
    } satisfies Observation

    return this.#mutate((current) => {
      const found = current.findings.find((item) => item.id === key || item.aliases.includes(key))
      if (found) {
        const updated = {
          ...found,
          title,
          updatedAt: timestamp,
          observations: [...found.observations, observation],
        } satisfies Finding
        return {
          next: { ...current, findings: current.findings.map((item) => (item.id === found.id ? updated : item)) },
          value: updated,
          changed: true,
        }
      }
      const finding = {
        id: Identifier.create("fnd", "ascending"),
        aliases: [key],
        title,
        origin: { workflow: runContext.workflow, source: "finding" },
        createdAt: timestamp,
        updatedAt: timestamp,
        observations: [observation],
      } satisfies Finding
      return { next: { ...current, findings: [...current.findings, finding] }, value: finding, changed: true }
    }, signal)
  }

  async revisit(input: Record<string, unknown>, runContext: RunContext, signal?: AbortSignal) {
    const id = reference(input.id, "finding id or alias")
    const plan = boundedText(input.plan, "finding revisit plan", 4_000)
    const summary = boundedText(input.summary ?? input.plan, "finding summary", 4_000)
    const timestamp = this.#now().toISOString()
    return this.#mutate((current) => {
      const found = findFinding(current, id)
      if (!found) throw missingFinding(current, id)
      const previous = latestAssessed(found)
      const observation = {
        id: Identifier.create("obs", "ascending"),
        runID: runContext.runID,
        phase: runContext.phase,
        timestamp,
        review: "IN_REVIEW",
        plan,
        ...(previous ? { carriedState: previous.disposition.state } : {}),
        severity: previous?.severity ?? "UNRATED",
        verification: { result: "NOT_REVIEWED" },
        submission: { result: "NOT_ASSESSED" },
        summary,
        evidencePaths: evidencePaths(input.evidence_paths),
      } satisfies Observation
      const updated = {
        ...found,
        updatedAt: timestamp,
        observations: [...found.observations, observation],
      } satisfies Finding
      return {
        next: { ...current, findings: current.findings.map((item) => (item.id === found.id ? updated : item)) },
        value: updated,
        changed: true,
      }
    }, signal)
  }

  async update(input: Record<string, unknown>, runContext: RunContext, signal?: AbortSignal) {
    const id = reference(input.id, "finding id or alias")
    const nextDisposition = disposition(input)
    const requestedSeverity = input.severity === undefined ? undefined : ratedSeverity(input.severity)
    const summary = boundedText(input.summary, "finding summary", 4_000)
    const timestamp = this.#now().toISOString()
    const decisionsValue = decisions(input, runContext.workflow, nextDisposition)

    return this.#mutate((current) => {
      const found = findFinding(current, id)
      if (!found) throw missingFinding(current, id)
      const previous = latestAssessed(found)
      const severity = requestedSeverity ?? previous?.severity
      if (!severity || severity === "UNRATED")
        throw new Error(`finding '${id}' requires a severity before it can be updated`)
      if (previous && !transitions[previous.disposition.state].includes(nextDisposition.state))
        throw invalidFindingTransition({
          revision: current.revision,
          currentState: previous.disposition.state,
          requestedState: nextDisposition.state,
          allowedStates: transitions[previous.disposition.state],
          message: `finding '${id}' cannot transition from ${previous.disposition.state} to ${nextDisposition.state}`,
        })
      const observation = {
        id: Identifier.create("obs", "ascending"),
        runID: runContext.runID,
        phase: runContext.phase,
        timestamp,
        review: "ASSESSED",
        disposition: nextDisposition,
        severity,
        ...decisionsValue,
        summary,
        evidencePaths: evidencePaths(input.evidence_paths),
      } satisfies Observation
      const updated = {
        ...found,
        ...(input.title === undefined ? {} : { title: boundedText(input.title, "finding title", 300) }),
        updatedAt: timestamp,
        observations: [...found.observations, observation],
      } satisfies Finding
      return {
        next: { ...current, findings: current.findings.map((item) => (item.id === found.id ? updated : item)) },
        value: updated,
        changed: true,
      }
    }, signal)
  }

  async alias(input: Record<string, unknown>, signal?: AbortSignal) {
    const id = reference(input.id, "finding id or alias")
    const alias = reference(input.alias, "finding alias")
    const timestamp = this.#now().toISOString()
    return this.#mutate((current) => {
      const found = findFinding(current, id)
      if (!found) throw missingFinding(current, id)
      const conflict = current.findings.find((item) => item.id === alias || item.aliases.includes(alias))
      if (conflict && conflict.id !== found.id)
        throw new Error(`finding alias '${alias}' already belongs to ${conflict.id}`)
      if (found.aliases.includes(alias)) return { next: current, value: found, changed: false }
      const updated = { ...found, aliases: [...found.aliases, alias], updatedAt: timestamp } satisfies Finding
      return {
        next: { ...current, findings: current.findings.map((item) => (item.id === found.id ? updated : item)) },
        value: updated,
        changed: true,
      }
    }, signal)
  }

  async syncCodeGraph(
    inputs: readonly CodeGraphMirrorFinding[],
    runContext: RunContext,
    options: { historical?: boolean } = {},
    signal?: AbortSignal,
  ) {
    const active = context(runContext)
    const historicalRunID = "legacy:code-graph"
    const runID = options.historical ? historicalRunID : active.runID
    const phase = options.historical ? "legacy-import" : active.phase
    return this.#mutate((current) => {
      let changed = false
      let findings = [...current.findings]
      const runs = [...current.runs]
      if (options.historical && inputs.length > 0 && !runs.some((item) => item.id === historicalRunID)) {
        const timestamp = inputs
          .map((item) => Date.parse(item.updatedAt))
          .filter(Number.isFinite)
          .toSorted((left, right) => left - right)[0]
        const startedAt = new Date(timestamp ?? 0).toISOString()
        runs.push({
          id: historicalRunID,
          workflow: "code-audit",
          startedAt,
          endedAt: startedAt,
          status: "COMPLETED",
        })
        changed = true
      }

      for (const input of inputs) {
        const sourceID = reference(input.id, "Code Graph finding id")
        const timestamp = new Date(input.updatedAt)
        if (!Number.isFinite(timestamp.getTime()))
          throw new Error("Code Graph finding updatedAt must be an ISO timestamp")
        const observedAt = timestamp.toISOString()
        const found = findings.find(
          (item) => item.origin.sourceID === sourceID || item.id === sourceID || item.aliases.includes(sourceID),
        )
        if (
          found?.observations.some(
            (item) => item.timestamp === observedAt && (options.historical || item.runID === active.runID),
          )
        )
          continue

        const evidence = input.evidence
          .map((item) => boundedText(item.description, "Code Graph finding evidence", 8_000))
          .join("\n")
        if (!evidence) throw new Error("Code Graph finding requires positive evidence")
        const severity = input.severity.toUpperCase() as Severity
        const dispositionValue: Disposition =
          input.status === "confirmed"
            ? { state: "CONFIRMED", proof: evidence }
            : input.status === "dismissed"
              ? {
                  state: "DISPROVED",
                  reason: boundedText(
                    input.transitionReason ?? "Dismissed by Code Audit Verify.",
                    "Code Graph dismissal reason",
                    8_000,
                  ),
                }
              : { state: "SUSPECTED", positiveEvidence: evidence }
        const verification: Verification =
          input.status === "confirmed"
            ? { result: "SURVIVES", rationale: "Confirmed by the specialized Code Audit ledger." }
            : input.status === "dismissed"
              ? {
                  result: "DEMOTE",
                  rationale: input.transitionReason ?? "Dismissed by the specialized Code Audit ledger.",
                }
              : { result: "NOT_REVIEWED" }
        const observation = {
          id: Identifier.create("obs", "ascending"),
          runID,
          phase,
          timestamp: observedAt,
          review: "ASSESSED",
          disposition: dispositionValue,
          severity,
          verification,
          submission: { result: "NOT_ASSESSED" },
          summary: boundedText(
            `${input.weakness} · confidence ${input.confidence}`,
            "Code Graph finding summary",
            4_000,
          ),
          evidencePaths: ["raw/code-graph/index.sqlite"],
        } satisfies Observation

        if (found) {
          const updated = {
            ...found,
            title: boundedText(input.title, "Code Graph finding title", 300),
            aliases: found.aliases.includes(sourceID) ? found.aliases : [...found.aliases, sourceID],
            updatedAt: observedAt,
            observations: [...found.observations, observation],
          } satisfies Finding
          findings = findings.map((item) => (item.id === found.id ? updated : item))
        } else {
          findings.push({
            id: Identifier.create("fnd", "ascending"),
            aliases: [sourceID],
            title: boundedText(input.title, "Code Graph finding title", 300),
            origin: { workflow: "code-audit", source: "code-graph", sourceID },
            createdAt: observedAt,
            updatedAt: observedAt,
            observations: [observation],
          })
        }
        changed = true
      }
      return {
        next: changed ? { ...current, runs, findings } : current,
        value: findings,
        changed,
      }
    }, signal)
  }
}

export * as FindingRegistry from "./registry"
