// ── Live-Target Verdict Taxonomy ────────────────────────────────
// Validates the structured verdict inventory carried by Exploit and Hacker
// handoffs, keeping positive suspicion separate from hypotheses that could not run.
// → cyberful/src/subsystem/gateway/server.ts — validates model-provided handoffs.
// @docs/user-guide/workflows.md
// ─────────────────────────────────────────────────────────────────

import { isRecord } from "@/util/record"

export const BLOCKER_REASONS = [
  "MISSING_PREREQUISITE",
  "OUT_OF_SCOPE_DEPENDENCY",
  "NO_CONCRETE_ROUTE",
  "MISSING_APPLICABILITY_EVIDENCE",
  "UNSAFE_ORACLE",
  "AUTHORITY_REQUIRED",
  "TOOL_UNAVAILABLE",
  "BUDGET_EXHAUSTED",
] as const

export type BlockerReason = (typeof BLOCKER_REASONS)[number]

export interface SuspectedVerdict {
  readonly id: string
  readonly positiveEvidence: string
}

export interface InconclusiveVerdict {
  readonly id: string
  readonly ambiguity: string
}

export interface UntestableVerdict {
  readonly id: string
  readonly blockerReason: BlockerReason
  readonly nextStep: string
}

export interface Ledger {
  readonly confirmed: readonly string[]
  readonly disproved: readonly string[]
  readonly suspected: readonly SuspectedVerdict[]
  readonly inconclusive: readonly InconclusiveVerdict[]
  readonly untestable: readonly UntestableVerdict[]
}

export interface Counts {
  readonly confirmed: number
  readonly disproved: number
  readonly suspected: number
  readonly inconclusive: number
  readonly untestable: number
}

const MAX_ITEMS = 200
const MAX_ID_LENGTH = 128
const MAX_EXPLANATION_LENGTH = 2_000

function isBlockerReason(value: unknown): value is BlockerReason {
  return typeof value === "string" && BLOCKER_REASONS.some((reason) => reason === value)
}

function nonEmptyText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} must not be empty`)
  if (normalized.length > maximum) throw new Error(`${label} must contain at most ${maximum} characters`)
  if (/\p{Cc}/u.test(normalized)) throw new Error(`${label} must not contain control characters`)
  return normalized
}

function findingID(value: unknown, label: string): string {
  return nonEmptyText(value, label, MAX_ID_LENGTH)
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  if (value.length > MAX_ITEMS) throw new Error(`${label} must contain at most ${MAX_ITEMS} items`)
  return value
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported fields: ${unexpected.join(", ")}`)
}

function parseSuspected(value: unknown, index: number): SuspectedVerdict {
  if (!isRecord(value)) throw new Error(`verdicts.suspected[${index}] must be an object`)
  exactKeys(value, ["id", "positive_evidence"], `verdicts.suspected[${index}]`)
  return {
    id: findingID(value.id, `verdicts.suspected[${index}].id`),
    positiveEvidence: nonEmptyText(
      value.positive_evidence,
      `verdicts.suspected[${index}].positive_evidence`,
      MAX_EXPLANATION_LENGTH,
    ),
  }
}

function parseInconclusive(value: unknown, index: number): InconclusiveVerdict {
  if (!isRecord(value)) throw new Error(`verdicts.inconclusive[${index}] must be an object`)
  exactKeys(value, ["id", "ambiguity"], `verdicts.inconclusive[${index}]`)
  return {
    id: findingID(value.id, `verdicts.inconclusive[${index}].id`),
    ambiguity: nonEmptyText(
      value.ambiguity,
      `verdicts.inconclusive[${index}].ambiguity`,
      MAX_EXPLANATION_LENGTH,
    ),
  }
}

function parseUntestable(value: unknown, index: number): UntestableVerdict {
  if (!isRecord(value)) throw new Error(`verdicts.untestable[${index}] must be an object`)
  exactKeys(value, ["id", "blocker_reason", "next_step"], `verdicts.untestable[${index}]`)
  if (!isBlockerReason(value.blocker_reason))
    throw new Error(`verdicts.untestable[${index}].blocker_reason is invalid`)
  return {
    id: findingID(value.id, `verdicts.untestable[${index}].id`),
    blockerReason: value.blocker_reason,
    nextStep: nonEmptyText(value.next_step, `verdicts.untestable[${index}].next_step`, MAX_EXPLANATION_LENGTH),
  }
}

// ── Verdict Classes Are Mutually Exclusive ──────────────────────
// One hypothesis has exactly one disposition at a phase boundary. Suspected
// requires affirmative target evidence, inconclusive means a valid test ran but
// remained ambiguous, and untestable means the discriminating test never ran.
// Rejecting duplicate IDs prevents counts from implying more coverage than the
// handoff actually contains and gives successor phases one canonical inventory.
// ─────────────────────────────────────────────────────────────────
export function parse(input: unknown): Ledger | undefined {
  if (input === undefined) return undefined
  if (!isRecord(input)) throw new Error("handoff verdicts must be an object")
  exactKeys(input, ["confirmed", "disproved", "suspected", "inconclusive", "untestable"], "verdicts")
  const ledger: Ledger = {
    confirmed: array(input.confirmed, "verdicts.confirmed").map((value, index) =>
      findingID(value, `verdicts.confirmed[${index}]`),
    ),
    disproved: array(input.disproved, "verdicts.disproved").map((value, index) =>
      findingID(value, `verdicts.disproved[${index}]`),
    ),
    suspected: array(input.suspected, "verdicts.suspected").map(parseSuspected),
    inconclusive: array(input.inconclusive, "verdicts.inconclusive").map(parseInconclusive),
    untestable: array(input.untestable, "verdicts.untestable").map(parseUntestable),
  }
  const ids = [
    ...ledger.confirmed,
    ...ledger.disproved,
    ...ledger.suspected.map((item) => item.id),
    ...ledger.inconclusive.map((item) => item.id),
    ...ledger.untestable.map((item) => item.id),
  ]
  if (new Set(ids).size !== ids.length) throw new Error("handoff verdict IDs must be unique across every class")
  return ledger
}

export function counts(ledger: Ledger): Counts {
  return {
    confirmed: ledger.confirmed.length,
    disproved: ledger.disproved.length,
    suspected: ledger.suspected.length,
    inconclusive: ledger.inconclusive.length,
    untestable: ledger.untestable.length,
  }
}

export function requiredFor(workflow: string | undefined, phase: string): boolean {
  return (workflow === "pentest" || workflow === "bug-bounty") && (phase === "exploit" || phase === "hacker")
}

export const INPUT_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    confirmed: { type: "array", maxItems: MAX_ITEMS, items: { type: "string", maxLength: MAX_ID_LENGTH } },
    disproved: { type: "array", maxItems: MAX_ITEMS, items: { type: "string", maxLength: MAX_ID_LENGTH } },
    suspected: {
      type: "array",
      maxItems: MAX_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", maxLength: MAX_ID_LENGTH },
          positive_evidence: { type: "string", maxLength: MAX_EXPLANATION_LENGTH },
        },
        required: ["id", "positive_evidence"],
      },
    },
    inconclusive: {
      type: "array",
      maxItems: MAX_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", maxLength: MAX_ID_LENGTH },
          ambiguity: { type: "string", maxLength: MAX_EXPLANATION_LENGTH },
        },
        required: ["id", "ambiguity"],
      },
    },
    untestable: {
      type: "array",
      maxItems: MAX_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", maxLength: MAX_ID_LENGTH },
          blocker_reason: { type: "string", enum: BLOCKER_REASONS },
          next_step: { type: "string", maxLength: MAX_EXPLANATION_LENGTH },
        },
        required: ["id", "blocker_reason", "next_step"],
      },
    },
  },
  required: ["confirmed", "disproved", "suspected", "inconclusive", "untestable"],
}

export * as SubsystemVerdict from "./verdict"
