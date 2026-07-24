// ── Target-Specific Novelty Ledger ──────────────────────────────
// Records hypotheses in batches and requires one evidence-backed contrarian
//   synthesis, while never imposing numeric diversity quotas on phase handoff.
// → cyberful/src/subsystem/novelty.ts — enables the qualitative contract.
// → cyberful/src/subsystem/gateway/server.ts — exposes and checks the ledger.
// @docs/user-guide/workflows.md
// ─────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { isRecord } from "@/util/record"
import { SubsystemNovelty, type Contract } from "../novelty"

const SOURCE_KINDS = ["hypothesis", "candidate", "finding", "coverage_backlog", "ledger"] as const
type SourceKind = (typeof SOURCE_KINDS)[number]

interface SourceRef {
  readonly phase: string
  readonly kind: SourceKind
  readonly id: string
}

interface HypothesisEntry {
  readonly version: 1
  readonly type: "hypothesis"
  readonly time_iso: string
  readonly phase: string
  readonly id: string
  readonly title: string
  readonly root_cause: string
  readonly enforcement_owner: string
  readonly protocol: string
  readonly state_transition: string
  readonly attacker_capability: string
  readonly oracle: string
  readonly target_facts: readonly string[]
  readonly parent_id?: string
  readonly source_ref?: SourceRef
  readonly fingerprint_sha256: string
}

interface SignalEntry {
  readonly version: 1
  readonly type: "convergence_signal"
  readonly time_iso: string
  readonly phase: string
  readonly fingerprint_sha256: string
}

interface SynthesisEntry {
  readonly version: 1
  readonly type: "synthesis"
  readonly time_iso: string
  readonly phase: string
  readonly outcome: "diversified" | "exhausted"
  readonly contrarian_summary: string
  readonly evidence: readonly string[]
  readonly remaining_unknowns: readonly string[]
}

type Entry = HypothesisEntry | SignalEntry | SynthesisEntry

export interface Status {
  readonly contract: Contract
  readonly hypotheses: number
  readonly distinctFamilies: number
  readonly convergenceSignaled: boolean
  readonly synthesisCompleted: boolean
  readonly gaps: readonly string[]
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const normalized = value.trim().replace(/\s+/g, " ")
  if (!normalized) throw new Error(`${label} must not be empty`)
  if (normalized.length > maximum) throw new Error(`${label} must contain at most ${maximum} characters`)
  if (/\p{Cc}/u.test(normalized)) throw new Error(`${label} must not contain control characters`)
  return normalized
}

function identifier(value: unknown, label: string): string {
  const id = boundedText(value, label, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id))
    throw new Error(`${label} must use letters, numbers, dot, colon, underscore, or dash`)
  return id
}

function phaseID(value: unknown): string {
  const phase = boundedText(value, "novelty phase", 80)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(phase)) throw new Error("novelty phase must be a lowercase phase identifier")
  return phase
}

function textArray(value: unknown, label: string, maximumItems: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems)
    throw new Error(`${label} must be an array of at most ${maximumItems} strings`)
  return value.map((item, index) => boundedText(item, `${label}[${index}]`, 500))
}

function canonical(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

function fingerprint(entry: Pick<HypothesisEntry, "root_cause" | "enforcement_owner" | "protocol" | "state_transition" | "attacker_capability" | "oracle">) {
  return createHash("sha256")
    .update(
      [entry.root_cause, entry.enforcement_owner, entry.protocol, entry.state_transition, entry.attacker_capability, entry.oracle]
        .map(canonical)
        .join("\0"),
    )
    .digest("hex")
}

function sourceRef(value: unknown): SourceRef | undefined {
  if (value === undefined) return
  if (!isRecord(value)) throw new Error("novelty source_ref must be an object")
  const keys = Object.keys(value)
  if (keys.some((key) => !["phase", "kind", "id"].includes(key)))
    throw new Error("novelty source_ref contains unsupported fields")
  const kind = boundedText(value.kind, "novelty source_ref.kind", 40)
  if (!SOURCE_KINDS.some((candidate) => candidate === kind)) throw new Error("novelty source_ref.kind is invalid")
  return { phase: phaseID(value.phase), kind: kind as SourceKind, id: identifier(value.id, "novelty source_ref.id") }
}

function parseEntry(value: unknown): Entry | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.type !== "string") return
  if (value.type === "convergence_signal") {
    if (typeof value.time_iso !== "string" || typeof value.phase !== "string" || typeof value.fingerprint_sha256 !== "string") return
    return value as unknown as SignalEntry
  }
  if (value.type === "synthesis") {
    if (
      typeof value.time_iso !== "string" ||
      typeof value.phase !== "string" ||
      (value.outcome !== "diversified" && value.outcome !== "exhausted") ||
      typeof value.contrarian_summary !== "string" ||
      !Array.isArray(value.evidence) ||
      !value.evidence.every((item) => typeof item === "string") ||
      !Array.isArray(value.remaining_unknowns) ||
      !value.remaining_unknowns.every((item) => typeof item === "string")
    ) return
    return value as unknown as SynthesisEntry
  }
  if (value.type !== "hypothesis") return
  const strings = ["time_iso", "phase", "id", "title", "root_cause", "enforcement_owner", "protocol", "state_transition", "attacker_capability", "oracle", "fingerprint_sha256"] as const
  if (strings.some((field) => typeof value[field] !== "string")) return
  if (!Array.isArray(value.target_facts) || !value.target_facts.every((item) => typeof item === "string")) return
  return value as unknown as HypothesisEntry
}

function recordInputs(args: Record<string, unknown>): readonly Record<string, unknown>[] {
  if (args.records === undefined) return [args]
  if (!Array.isArray(args.records) || args.records.length === 0 || args.records.length > 50)
    throw new Error("novelty records must contain between 1 and 50 hypotheses")
  if (args.records.some((item) => !isRecord(item))) throw new Error("each novelty record must be an object")
  return args.records as Record<string, unknown>[]
}

export class NoveltyLedger {
  readonly #file: string
  readonly #phase: string
  readonly #contract: Contract
  #queue: Promise<void> = Promise.resolve()

  constructor(workareaRoot: string, phase: string, contract: Contract) {
    if (!path.isAbsolute(workareaRoot)) throw new Error("novelty ledger requires an absolute workarea root")
    this.#phase = phaseID(phase)
    this.#contract = contract
    this.#file = path.join(workareaRoot, "raw", "operations", "novelty", `${this.#phase}.jsonl`)
  }

  async record(args: Record<string, unknown>) {
    const pending = this.#queue.then(async () => {
      const previous = await this.#entries()
      const existing = new Set(previous.filter((entry): entry is HypothesisEntry => entry.type === "hypothesis").map((entry) => entry.id))
      const entries: HypothesisEntry[] = []
      for (const input of recordInputs(args)) {
        const id = identifier(input.id, "novelty id")
        if (existing.has(id)) throw new Error(`novelty hypothesis '${id}' already exists`)
        const targetFacts = textArray(input.target_facts, "novelty target_facts", 20)
        if (targetFacts.length === 0) throw new Error("novelty target_facts must contain at least one target-specific fact")
        const parentID = input.parent_id === undefined ? undefined : identifier(input.parent_id, "novelty parent_id")
        if (parentID && !existing.has(parentID)) throw new Error(`novelty parent '${parentID}' does not exist in phase '${this.#phase}'`)
        const base = {
          id,
          title: boundedText(input.title, "novelty title", 240),
          root_cause: boundedText(input.root_cause, "novelty root_cause", 160),
          enforcement_owner: boundedText(input.enforcement_owner, "novelty enforcement_owner", 160),
          protocol: boundedText(input.protocol, "novelty protocol", 120),
          state_transition: boundedText(input.state_transition, "novelty state_transition", 200),
          attacker_capability: boundedText(input.attacker_capability, "novelty attacker_capability", 240),
          oracle: boundedText(input.oracle, "novelty oracle", 240),
          target_facts: targetFacts,
          ...(parentID ? { parent_id: parentID } : {}),
          ...(input.source_ref === undefined ? {} : { source_ref: sourceRef(input.source_ref) }),
        }
        const entry: HypothesisEntry = {
          version: 1,
          type: "hypothesis",
          time_iso: new Date().toISOString(),
          phase: this.#phase,
          ...base,
          fingerprint_sha256: fingerprint(base),
        }
        entries.push(entry)
        existing.add(id)
      }
      const before = previous.filter((entry): entry is HypothesisEntry => entry.type === "hypothesis")
      const duplicate = entries.some((entry) => before.some((item) => item.fingerprint_sha256 === entry.fingerprint_sha256))
      const alreadySignaled = previous.some((entry) => entry.type === "convergence_signal")
      const signal = duplicate && !alreadySignaled
      const additions: Entry[] = [...entries]
      if (signal) {
        additions.push({ version: 1, type: "convergence_signal", time_iso: new Date().toISOString(), phase: this.#phase, fingerprint_sha256: entries.find((entry) => before.some((item) => item.fingerprint_sha256 === entry.fingerprint_sha256))!.fingerprint_sha256 })
      }
      await this.#append(additions)
      return {
        recorded: entries.map((entry) => entry.id),
        duplicateMechanism: duplicate,
        antiConvergence: {
          signal,
          guidance: signal ? "Research is repeating one causal mechanism; make a semantic pivot or document target-specific exhaustion." : undefined,
        },
        status: this.#status([...previous, ...additions]),
      }
    })
    this.#queue = pending.then(() => undefined, () => undefined)
    return pending
  }

  async synthesize(args: Record<string, unknown>) {
    const pending = this.#queue.then(async () => {
      const entries = await this.#entries()
      if (args.outcome !== "diversified" && args.outcome !== "exhausted")
        throw new Error("novelty outcome must be diversified or exhausted")
      const evidence = textArray(args.evidence, "novelty evidence", 30)
      if (evidence.length === 0) throw new Error("novelty evidence must document a pivot or target-specific exhaustion")
      const entry: SynthesisEntry = {
        version: 1,
        type: "synthesis",
        time_iso: new Date().toISOString(),
        phase: this.#phase,
        outcome: args.outcome,
        contrarian_summary: boundedText(args.contrarian_summary, "novelty contrarian_summary", 4_000),
        evidence,
        remaining_unknowns: textArray(args.remaining_unknowns ?? [], "novelty remaining_unknowns", 30),
      }
      await this.#append([entry])
      return this.#status([...entries, entry])
    })
    this.#queue = pending.then(() => undefined, () => undefined)
    return pending
  }

  async status(): Promise<Status> {
    return this.#status(await this.#entries())
  }

  async handoffError(): Promise<string | undefined> {
    const status = await this.status()
    return status.synthesisCompleted ? undefined : "novelty contract is incomplete: contrarian synthesis missing"
  }

  async #entries(): Promise<readonly Entry[]> {
    const content = await readFile(this.#file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
    return content.split(/\r?\n/).filter(Boolean).map((line) => {
      let value: unknown
      try { value = JSON.parse(line) } catch (error) { throw new Error("novelty ledger contains invalid JSON", { cause: error }) }
      const entry = parseEntry(value)
      if (!entry) throw new Error("novelty ledger contains an invalid entry")
      return entry
    })
  }

  async #append(entries: readonly Entry[]): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 })
    await writeFile(this.#file, "", { flag: "a", mode: 0o600 })
    await appendFile(this.#file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
  }

  #status(entries: readonly Entry[]): Status {
    const hypotheses = entries.filter((entry): entry is HypothesisEntry => entry.type === "hypothesis")
    const synthesisCompleted = entries.at(-1)?.type === "synthesis"
    return {
      contract: this.#contract,
      hypotheses: hypotheses.length,
      distinctFamilies: new Set(hypotheses.map((entry) => entry.fingerprint_sha256)).size,
      convergenceSignaled: entries.some((entry) => entry.type === "convergence_signal"),
      synthesisCompleted,
      gaps: synthesisCompleted ? [] : ["contrarian synthesis missing"],
    }
  }
}

const HYPOTHESIS_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    id: { type: "string", maxLength: 128 },
    title: { type: "string", maxLength: 240 },
    root_cause: { type: "string", maxLength: 160 },
    enforcement_owner: { type: "string", maxLength: 160 },
    protocol: { type: "string", maxLength: 120 },
    state_transition: { type: "string", maxLength: 200 },
    attacker_capability: { type: "string", maxLength: 240 },
    oracle: { type: "string", maxLength: 240 },
    target_facts: { type: "array", maxItems: 20, items: { type: "string", maxLength: 500 } },
    parent_id: { type: "string", maxLength: 128 },
    source_ref: {
      type: "object",
      additionalProperties: false,
      properties: {
        phase: { type: "string", maxLength: 80 },
        kind: { type: "string", enum: SOURCE_KINDS },
        id: { type: "string", maxLength: 128 },
      },
      required: ["phase", "kind", "id"],
    },
  },
  required: ["id", "title", "root_cause", "enforcement_owner", "protocol", "state_transition", "attacker_capability", "oracle", "target_facts"],
}

export const NOVELTY_TOOL_DEF = {
  name: "novelty",
  description: "Record target-specific hypotheses, inspect causal diversity, and submit one evidence-backed contrarian synthesis. No numeric quota applies.",
  inputSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["record", "status", "synthesize"] },
      ...HYPOTHESIS_SCHEMA.properties,
      records: { type: "array", minItems: 1, maxItems: 50, items: HYPOTHESIS_SCHEMA },
      outcome: { type: "string", enum: ["diversified", "exhausted"] },
      contrarian_summary: { type: "string", maxLength: 4_000 },
      evidence: { type: "array", maxItems: 30, items: { type: "string", maxLength: 500 } },
      remaining_unknowns: { type: "array", maxItems: 30, items: { type: "string", maxLength: 500 } },
    },
    required: ["action"],
  },
}

export function noveltyLedgerFromEnvironment(): NoveltyLedger | undefined {
  const workarea = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim()
  const phase = process.env.CYBERFUL_SUBSYSTEM_PHASE?.trim()
  const contract = SubsystemNovelty.parseEnvironment()
  return workarea && phase && contract ? new NoveltyLedger(workarea, phase, contract) : undefined
}

export * as GatewayNovelty from "./novelty-ledger"
