// ── Cross-Workflow Hypothesis Registry ──────────────────────────
// Persists investigation questions and their lifecycle once per workarea so
//   Pentest, Bug Bounty, and Code Audit phases share one durable backlog.
// → cyberful/src/subsystem/gateway/server.ts — exposes the phase-scoped tool and handoff gate.
// → cyberful/src/finding/registry.ts — remains the separate authority for reportable findings.
// @docs/concepts/execution-model.md
// @docs/user-guide/workflows.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isRecord } from "@/util/record"
import { replaceWorkareaFile } from "@/workarea"
import { BLOCKER_REASONS, type BlockerReason } from "../verdict"

export const HYPOTHESIS_REGISTRY_PATH = "raw/hypotheses/registry.json"

const STATES = [
  "OPEN",
  "QUEUED",
  "TESTING",
  "SUSPECTED",
  "CONFIRMED",
  "DISPROVED",
  "INCONCLUSIVE",
  "UNTESTABLE",
] as const
type State = (typeof STATES)[number]
const OMISSION_REASONS = [
  "not_discovered",
  "not_loaded",
  "selection_error",
  "tool_failure",
  "timeout",
  "policy_scope",
  "contention",
  "budget",
  "duplicate_capability",
  "not_needed",
] as const
type OmissionReason = (typeof OMISSION_REASONS)[number]

interface ScopeResolution {
  readonly exact_action: string
  readonly asset: string
  readonly required_rule: string
  readonly sources_checked: readonly string[]
  readonly ambiguity: string
  readonly resolution_attempt: string
  readonly next_step: string
}

interface Transition {
  readonly time_iso: string
  readonly phase: string
  readonly owner: string
  readonly from?: State
  readonly to: State
  readonly evidence: readonly string[]
  readonly reason?: string
}

interface Hypothesis {
  readonly id: string
  readonly fingerprint_sha256: string
  readonly workflow: string
  readonly phase: string
  readonly owner: string
  readonly description: string
  readonly root_cause: string
  readonly surface: string
  readonly discriminator: string
  readonly candidate_tools: readonly string[]
  readonly omitted_tools: ReadonlyArray<{ readonly tool: string; readonly reason: OmissionReason }>
  readonly state: State
  readonly evidence: readonly string[]
  readonly evidence_refs: readonly string[]
  readonly blocker?: string
  readonly blocker_reason?: BlockerReason
  readonly next_step?: string
  readonly next_phase?: string
  readonly finding_id?: string
  readonly scope_resolution?: ScopeResolution
  readonly graph_refs: readonly string[]
  readonly transitions: readonly Transition[]
}

interface Synthesis {
  readonly time_iso: string
  readonly phase: string
  readonly outcome: "diversified" | "exhausted"
  readonly summary: string
  readonly evidence: readonly string[]
  readonly remaining_unknowns: readonly string[]
}

interface Registry {
  readonly version: 1
  readonly revision: number
  readonly updated_at: string
  readonly hypotheses: readonly Hypothesis[]
  readonly syntheses: readonly Synthesis[]
}

function emptyRegistry(): Registry {
  return {
    version: 1,
    revision: 0,
    updated_at: new Date(0).toISOString(),
    hypotheses: [],
    syntheses: [],
  }
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const normalized = value.trim().replace(/\s+/g, " ")
  if (!normalized) throw new Error(`${label} must not be empty`)
  if (normalized.length > maximum) throw new Error(`${label} must contain at most ${maximum} characters`)
  if (/\p{Cc}/u.test(normalized)) throw new Error(`${label} must not contain control characters`)
  return normalized
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedText(value, label, maximum)
}

function identifier(value: unknown, label: string): string {
  const id = boundedText(value, label, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id))
    throw new Error(`${label} must use letters, numbers, dot, colon, underscore, or dash`)
  return id
}

function textArray(value: unknown, label: string, maximumItems: number): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximumItems)
    throw new Error(`${label} must be an array of at most ${maximumItems} strings`)
  return value.map((item, index) => boundedText(item, `${label}[${index}]`, 1_000))
}

function state(value: unknown): State {
  if (typeof value !== "string" || !STATES.some((candidate) => candidate === value))
    throw new Error(`hypothesis state must be one of ${STATES.join(", ")}`)
  return value as State
}

function blockerReason(value: unknown): BlockerReason | undefined {
  if (value === undefined) return
  if (typeof value !== "string" || !BLOCKER_REASONS.some((candidate) => candidate === value))
    throw new Error(`hypothesis blocker_reason must be one of ${BLOCKER_REASONS.join(", ")}`)
  return value as BlockerReason
}

function omittedTools(value: unknown): Hypothesis["omitted_tools"] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 30)
    throw new Error("hypothesis omitted_tools must be an array of at most 30 entries")
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`hypothesis omitted_tools[${index}] must be an object`)
    const reason = boundedText(item.reason, `hypothesis omitted_tools[${index}].reason`, 80)
    if (!OMISSION_REASONS.some((candidate) => candidate === reason))
      throw new Error(`hypothesis omitted_tools[${index}].reason is invalid`)
    return {
      tool: boundedText(item.tool, `hypothesis omitted_tools[${index}].tool`, 160),
      reason: reason as OmissionReason,
    }
  })
}

function scopeResolution(value: unknown): ScopeResolution | undefined {
  if (value === undefined) return
  if (!isRecord(value)) throw new Error("hypothesis scope_resolution must be an object")
  return {
    exact_action: boundedText(value.exact_action, "hypothesis scope_resolution.exact_action", 500),
    asset: boundedText(value.asset, "hypothesis scope_resolution.asset", 500),
    required_rule: boundedText(value.required_rule, "hypothesis scope_resolution.required_rule", 500),
    sources_checked: textArray(value.sources_checked, "hypothesis scope_resolution.sources_checked", 20),
    ambiguity: boundedText(value.ambiguity, "hypothesis scope_resolution.ambiguity", 1_000),
    resolution_attempt: boundedText(
      value.resolution_attempt,
      "hypothesis scope_resolution.resolution_attempt",
      1_000,
    ),
    next_step: boundedText(value.next_step, "hypothesis scope_resolution.next_step", 1_000),
  }
}

function fingerprint(input: {
  readonly workflow: string
  readonly description: string
  readonly rootCause: string
  readonly surface: string
  readonly discriminator: string
}) {
  return createHash("sha256")
    .update(
      [input.workflow, input.description, input.rootCause, input.surface, input.discriminator]
        .map((value) => value.toLowerCase())
        .join("\n"),
    )
    .digest("hex")
}

function parseRegistry(value: unknown): Registry {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.hypotheses) || !Array.isArray(value.syntheses))
    throw new Error("hypothesis registry is invalid")
  if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0)
    throw new Error("hypothesis registry revision is invalid")
  if (typeof value.updated_at !== "string") throw new Error("hypothesis registry timestamp is invalid")
  return value as unknown as Registry
}

function validateDisposition(input: {
  readonly state: State
  readonly evidence: readonly string[]
  readonly blocker?: string
  readonly blockerReason?: BlockerReason
  readonly nextStep?: string
  readonly nextPhase?: string
  readonly findingID?: string
  readonly reason?: string
  readonly scopeResolution?: ScopeResolution
}) {
  if (input.state === "QUEUED" && (!input.nextPhase || !input.nextStep))
    throw new Error("QUEUED hypothesis requires next_phase and next_step")
  if ((input.state === "SUSPECTED" || input.state === "CONFIRMED") && !input.findingID)
    throw new Error(`${input.state} hypothesis requires finding_id`)
  if (["SUSPECTED", "CONFIRMED", "DISPROVED", "INCONCLUSIVE"].includes(input.state) && input.evidence.length === 0)
    throw new Error(`${input.state} hypothesis requires evidence`)
  if (input.state === "INCONCLUSIVE" && (!input.blocker || !input.nextStep))
    throw new Error("INCONCLUSIVE hypothesis requires blocker and next_step")
  if (input.state === "UNTESTABLE" && (!input.blocker || !input.blockerReason || !input.nextStep))
    throw new Error("UNTESTABLE hypothesis requires blocker, blocker_reason, and next_step")
  if (
    input.state === "UNTESTABLE" &&
    (input.blockerReason === "AUTHORITY_REQUIRED" || input.blockerReason === "OUT_OF_SCOPE_DEPENDENCY") &&
    !input.scopeResolution
  )
    throw new Error("scope-related UNTESTABLE hypothesis requires scope_resolution")
  if (
    ["SUSPECTED", "CONFIRMED", "DISPROVED", "INCONCLUSIVE", "UNTESTABLE"].includes(input.state) &&
    !input.reason
  )
    throw new Error(`${input.state} hypothesis requires a closure reason`)
}

// ── Phase Boundaries Carry Work Instead Of Dropping It ──────────
// OPEN and TESTING mean the current phase still owns unfinished work and must
// therefore block handoff. QUEUED is the explicit exception: it identifies the
// exact successor and next discriminating action. Terminal dispositions retain
// evidence, while positive states also link the separate finding authority.
// This gives every phase one close-or-carry rule without workflow-specific logs.
//
// @docs/user-guide/workflows.md
// ─────────────────────────────────────────────────────────────────
export class HypothesisRegistry {
  readonly #workarea: string
  readonly #workflow: string
  readonly #phase: string
  readonly #readOnly: boolean
  readonly #synthesisRequired: boolean
  #queue: Promise<void> = Promise.resolve()

  constructor(input: {
    readonly workarea: string
    readonly workflow: string
    readonly phase: string
    readonly readOnly?: boolean
    readonly synthesisRequired?: boolean
  }) {
    if (!path.isAbsolute(input.workarea)) throw new Error("hypothesis registry requires an absolute workarea root")
    this.#workarea = input.workarea
    this.#workflow = boundedText(input.workflow, "hypothesis workflow", 80)
    this.#phase = boundedText(input.phase, "hypothesis phase", 80)
    this.#readOnly = input.readOnly === true
    this.#synthesisRequired = input.synthesisRequired === true
  }

  handle(args: Record<string, unknown>) {
    if (args.action === "get") return this.get(args.id)
    if (args.action === "list" || args.action === "status") return this.list(args)
    if (this.#readOnly) throw new Error("hypothesis registry is read-only in this phase")
    if (args.action === "record") return this.#record(args)
    if (args.action === "update") return this.#update(args)
    if (args.action === "reopen") return this.#reopen(args)
    if (args.action === "synthesize") return this.#synthesize(args)
    throw new Error("hypothesis action must be record, update, reopen, get, list, status, or synthesize")
  }

  async get(value: unknown) {
    const id = identifier(value, "hypothesis id")
    const hypothesis = (await this.#read()).hypotheses.find((candidate) => candidate.id === id)
    if (!hypothesis) throw new Error(`hypothesis '${id}' does not exist`)
    return hypothesis
  }

  async list(args: Record<string, unknown> = {}) {
    const registry = await this.#read()
    const requestedState = args.state === undefined ? undefined : state(args.state)
    const hypotheses = registry.hypotheses.filter(
      (hypothesis) =>
        (args.workflow === undefined || hypothesis.workflow === args.workflow) &&
        (args.phase === undefined || hypothesis.phase === args.phase) &&
        (requestedState === undefined || hypothesis.state === requestedState),
    )
    return {
      revision: registry.revision,
      workflow: this.#workflow,
      phase: this.#phase,
      hypotheses,
      synthesis: registry.syntheses.findLast((item) => item.phase === this.#phase),
    }
  }

  async handoffError(successor?: string) {
    const registry = await this.#read()
    const owned = registry.hypotheses.filter(
      (hypothesis) => hypothesis.workflow === this.#workflow && hypothesis.phase === this.#phase,
    )
    const open = owned.filter((hypothesis) => hypothesis.state === "OPEN" || hypothesis.state === "TESTING")
    if (open.length > 0) return `hypothesis registry has unfinished entries: ${open.map((item) => item.id).join(", ")}`
    const invalidQueue = owned.filter(
      (hypothesis) => hypothesis.state === "QUEUED" && (!successor || hypothesis.next_phase !== successor),
    )
    if (invalidQueue.length > 0)
      return `hypothesis registry has entries queued to the wrong successor: ${invalidQueue.map((item) => item.id).join(", ")}`
    if (this.#synthesisRequired && !registry.syntheses.some((item) => item.phase === this.#phase))
      return "hypothesis registry requires phase synthesis before handoff"
  }

  async verdictInventory() {
    const hypotheses = (await this.#read()).hypotheses.filter(
      (hypothesis) => hypothesis.workflow === this.#workflow && hypothesis.phase === this.#phase,
    )
    return {
      confirmed: hypotheses.flatMap((item) => item.state === "CONFIRMED" && item.finding_id ? [item.finding_id] : []),
      disproved: hypotheses.filter((item) => item.state === "DISPROVED").map((item) => item.id),
      suspected: hypotheses.flatMap((item) =>
        item.state === "SUSPECTED" && item.finding_id
          ? [{ id: item.finding_id, positive_evidence: item.evidence.join("; ") }]
          : [],
      ),
      inconclusive: hypotheses
        .filter((item) => item.state === "INCONCLUSIVE")
        .map((item) => ({ id: item.id, ambiguity: item.blocker ?? item.evidence.join("; ") })),
      untestable: hypotheses
        .filter((item) => item.state === "UNTESTABLE" && item.blocker_reason && item.next_step)
        .map((item) => ({ id: item.id, blocker_reason: item.blocker_reason!, next_step: item.next_step! })),
    }
  }

  close() {
    return this.#queue
  }

  #record(args: Record<string, unknown>) {
    return this.#mutate((registry) => {
      const description = boundedText(args.description ?? args.objective ?? args.title, "hypothesis description", 1_000)
      const rootCause = boundedText(args.root_cause, "hypothesis root_cause", 500)
      const surface = boundedText(args.surface, "hypothesis surface", 500)
      const discriminator = boundedText(args.discriminator ?? args.oracle, "hypothesis discriminator", 1_000)
      const id = identifier(args.id, "hypothesis id")
      const fingerprintSha256 = fingerprint({
        workflow: this.#workflow,
        description,
        rootCause,
        surface,
        discriminator,
      })
      if (registry.hypotheses.some((item) => item.id === id)) throw new Error(`hypothesis '${id}' already exists`)
      const duplicate = registry.hypotheses.find((item) => item.fingerprint_sha256 === fingerprintSha256)
      if (duplicate) throw new Error(`hypothesis duplicates '${duplicate.id}'`)
      const owner = boundedText(args.owner, "hypothesis owner", 160)
      const now = new Date().toISOString()
      const hypothesis: Hypothesis = {
        id,
        fingerprint_sha256: fingerprintSha256,
        workflow: this.#workflow,
        phase: this.#phase,
        owner,
        description,
        root_cause: rootCause,
        surface,
        discriminator,
        candidate_tools: textArray(args.candidate_tools, "hypothesis candidate_tools", 30),
        omitted_tools: omittedTools(args.omitted_tools),
        state: "OPEN",
        evidence: textArray(args.evidence, "hypothesis evidence", 50),
        evidence_refs: textArray(args.evidence_refs, "hypothesis evidence_refs", 50),
        graph_refs: textArray(args.graph_refs, "hypothesis graph_refs", 50),
        transitions: [{ time_iso: now, phase: this.#phase, owner, to: "OPEN", evidence: [] }],
      }
      return { registry: { ...registry, hypotheses: [...registry.hypotheses, hypothesis] }, result: hypothesis }
    })
  }

  #update(args: Record<string, unknown>) {
    return this.#mutate((registry) => {
      const id = identifier(args.id, "hypothesis id")
      const index = registry.hypotheses.findIndex((item) => item.id === id)
      if (index < 0) throw new Error(`hypothesis '${id}' does not exist`)
      const previous = registry.hypotheses[index]!
      const nextState = state(args.state)
      const evidence = textArray(args.evidence, "hypothesis evidence", 50)
      const owner = optionalText(args.owner, "hypothesis owner", 160) ?? previous.owner
      const blocker = optionalText(args.blocker, "hypothesis blocker", 1_000)
      const nextStep = optionalText(args.next_step, "hypothesis next_step", 1_000)
      const nextPhase = optionalText(args.next_phase, "hypothesis next_phase", 80)
      const findingID = args.finding_id === undefined ? undefined : identifier(args.finding_id, "hypothesis finding_id")
      const reason = optionalText(args.reason, "hypothesis reason", 1_000)
      const typedBlockerReason = blockerReason(args.blocker_reason)
      const typedScopeResolution = scopeResolution(args.scope_resolution)
      validateDisposition({
        state: nextState,
        evidence,
        blocker,
        blockerReason: typedBlockerReason,
        nextStep,
        nextPhase,
        findingID,
        reason,
        scopeResolution: typedScopeResolution,
      })
      const now = new Date().toISOString()
      const updated: Hypothesis = {
        ...previous,
        phase: this.#phase,
        owner,
        state: nextState,
        evidence: [...previous.evidence, ...evidence],
        evidence_refs: [
          ...new Set([
            ...(previous.evidence_refs ?? []),
            ...textArray(args.evidence_refs, "hypothesis evidence_refs", 50),
          ]),
        ],
        omitted_tools: [
          ...(previous.omitted_tools ?? []),
          ...omittedTools(args.omitted_tools).filter(
            (omission) =>
              !(previous.omitted_tools ?? []).some(
                (previousOmission) =>
                  previousOmission.tool === omission.tool && previousOmission.reason === omission.reason,
              ),
          ),
        ],
        ...(blocker ? { blocker } : {}),
        ...(typedBlockerReason ? { blocker_reason: typedBlockerReason } : {}),
        ...(nextStep ? { next_step: nextStep } : {}),
        ...(nextPhase ? { next_phase: nextPhase } : {}),
        ...(findingID ? { finding_id: findingID } : {}),
        ...(typedScopeResolution ? { scope_resolution: typedScopeResolution } : {}),
        ...(args.graph_refs === undefined
          ? {}
          : { graph_refs: [...new Set([...previous.graph_refs, ...textArray(args.graph_refs, "hypothesis graph_refs", 50)])] }),
        transitions: [
          ...previous.transitions,
          {
            time_iso: now,
            phase: this.#phase,
            owner,
            from: previous.state,
            to: nextState,
            evidence,
            ...(reason ? { reason } : {}),
          },
        ],
      }
      const hypotheses = [...registry.hypotheses]
      hypotheses[index] = updated
      return { registry: { ...registry, hypotheses }, result: updated }
    })
  }

  #reopen(args: Record<string, unknown>) {
    return this.#mutate((registry) => {
      const id = identifier(args.id, "hypothesis id")
      const index = registry.hypotheses.findIndex((item) => item.id === id)
      if (index < 0) throw new Error(`hypothesis '${id}' does not exist`)
      const previous = registry.hypotheses[index]!
      if (previous.state !== "QUEUED" || previous.next_phase !== this.#phase)
        throw new Error(`hypothesis '${id}' is not queued to phase '${this.#phase}'`)
      const owner = optionalText(args.owner, "hypothesis owner", 160) ?? previous.owner
      const now = new Date().toISOString()
      const updated: Hypothesis = {
        ...previous,
        phase: this.#phase,
        owner,
        state: "TESTING",
        next_phase: undefined,
        transitions: [
          ...previous.transitions,
          {
            time_iso: now,
            phase: this.#phase,
            owner,
            from: "QUEUED",
            to: "TESTING",
            evidence: [],
          },
        ],
      }
      const hypotheses = [...registry.hypotheses]
      hypotheses[index] = updated
      return { registry: { ...registry, hypotheses }, result: updated }
    })
  }

  #synthesize(args: Record<string, unknown>) {
    return this.#mutate((registry) => {
      if (args.outcome !== "diversified" && args.outcome !== "exhausted")
        throw new Error("hypothesis synthesis outcome must be diversified or exhausted")
      const synthesis: Synthesis = {
        time_iso: new Date().toISOString(),
        phase: this.#phase,
        outcome: args.outcome,
        summary: boundedText(args.summary ?? args.contrarian_summary, "hypothesis synthesis summary", 4_000),
        evidence: textArray(args.evidence, "hypothesis synthesis evidence", 30),
        remaining_unknowns: textArray(args.remaining_unknowns, "hypothesis remaining_unknowns", 30),
      }
      if (synthesis.evidence.length === 0) throw new Error("hypothesis synthesis requires evidence")
      return {
        registry: {
          ...registry,
          syntheses: [...registry.syntheses.filter((item) => item.phase !== this.#phase), synthesis],
        },
        result: synthesis,
      }
    })
  }

  async #read(): Promise<Registry> {
    await this.#queue
    const file = path.join(this.#workarea, HYPOTHESIS_REGISTRY_PATH)
    const content = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    return content === undefined ? emptyRegistry() : parseRegistry(JSON.parse(content))
  }

  #mutate<T>(operation: (registry: Registry) => { readonly registry: Registry; readonly result: T }): Promise<T> {
    const pending = this.#queue.then(async () => {
      const current = await this.#readUnlocked()
      const mutation = operation(current)
      const next: Registry = {
        ...mutation.registry,
        revision: current.revision + 1,
        updated_at: new Date().toISOString(),
      }
      await replaceWorkareaFile(this.#workarea, HYPOTHESIS_REGISTRY_PATH, `${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
      })
      return mutation.result
    })
    this.#queue = pending.then(() => undefined, () => undefined)
    return pending
  }

  async #readUnlocked(): Promise<Registry> {
    const content = await readFile(path.join(this.#workarea, HYPOTHESIS_REGISTRY_PATH), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      },
    )
    return content === undefined ? emptyRegistry() : parseRegistry(JSON.parse(content))
  }
}

export const HYPOTHESIS_TOOL_DEF = {
  name: "hypothesis",
  description:
    "Record, test, carry, and close durable hypotheses across phases. OPEN and TESTING block handoff; QUEUED requires an exact successor and next step; positive states require a linked finding.",
  inputSchema: {
    type: "object" as const,
    additionalProperties: true,
    properties: {
      action: { type: "string", enum: ["record", "update", "reopen", "get", "list", "status", "synthesize"] },
      id: { type: "string" },
      workflow: { type: "string" },
      phase: { type: "string" },
      owner: { type: "string" },
      description: { type: "string" },
      root_cause: { type: "string" },
      surface: { type: "string" },
      discriminator: { type: "string" },
      candidate_tools: { type: "array", items: { type: "string" } },
      omitted_tools: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { tool: { type: "string" }, reason: { type: "string", enum: OMISSION_REASONS } },
          required: ["tool", "reason"],
        },
      },
      graph_refs: { type: "array", items: { type: "string" } },
      state: { type: "string", enum: STATES },
      evidence: { type: "array", items: { type: "string" } },
      evidence_refs: { type: "array", items: { type: "string" } },
      blocker: { type: "string" },
      blocker_reason: { type: "string", enum: BLOCKER_REASONS },
      next_step: { type: "string" },
      next_phase: { type: "string" },
      finding_id: { type: "string" },
      reason: { type: "string" },
      scope_resolution: {
        type: "object",
        additionalProperties: false,
        properties: {
          exact_action: { type: "string" },
          asset: { type: "string" },
          required_rule: { type: "string" },
          sources_checked: { type: "array", items: { type: "string" } },
          ambiguity: { type: "string" },
          resolution_attempt: { type: "string" },
          next_step: { type: "string" },
        },
        required: [
          "exact_action",
          "asset",
          "required_rule",
          "sources_checked",
          "ambiguity",
          "resolution_attempt",
          "next_step",
        ],
      },
      outcome: { type: "string", enum: ["diversified", "exhausted"] },
      summary: { type: "string" },
      remaining_unknowns: { type: "array", items: { type: "string" } },
    },
    required: ["action"],
  },
}

export * as GatewayHypothesisRegistry from "./hypothesis-registry"
