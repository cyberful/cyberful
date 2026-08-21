// ── ATT&CK Applicability And Review Contract ─────────────────────
// Defines the evidence-carrying assessment stored with hypotheses and finding
// observations without asserting that an agent-declared identifier is genuine.
// → cyberful/src/subsystem/gateway/hypothesis-registry.ts — owns research state.
// → cyberful/src/finding/registry.ts — preserves verified finding history.
// @docs/runtimes/mitre-attack.md
// ─────────────────────────────────────────────────────────────────

import { readAttackRuntimeSnapshot } from "./runtime"
import type { AttackDomain } from "./types"

export const ATTACK_APPLICABILITY = ["UNASSESSED", "APPLICABLE", "NOT_APPLICABLE", "UNAVAILABLE"] as const
export type AttackApplicability = (typeof ATTACK_APPLICABILITY)[number]

export const ATTACK_REVIEW = ["NOT_REVIEWED", "ACCEPTED", "REVISED", "REJECTED"] as const
export type AttackReview = (typeof ATTACK_REVIEW)[number]

export interface AttackMappingAssessment {
  readonly attack_id: string
  readonly stix_id?: string
  readonly domain?: AttackDomain
  readonly rationale: string
  readonly evidence_refs: readonly string[]
}

export interface AttackSnapshotReference {
  readonly snapshot_id: string
  readonly database_sha256: string
  readonly domains: readonly {
    readonly domain: AttackDomain
    readonly version: string
    readonly source_sha256: string
  }[]
}

export interface AttackAssessment {
  readonly applicability: AttackApplicability
  readonly rationale?: string
  readonly mappings: readonly AttackMappingAssessment[]
  readonly snapshot?: AttackSnapshotReference
  readonly review: AttackReview
  readonly review_rationale?: string
}

export const UNASSESSED_ATTACK: AttackAssessment = {
  applicability: "UNASSESSED",
  mappings: [],
  review: "NOT_REVIEWED",
}

function record(value: unknown, label: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function bounded(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const normalized = value.trim().replace(/\s+/g, " ")
  if (!normalized || normalized.length > maximum || /\p{Cc}/u.test(normalized)) throw new Error(`${label} is invalid`)
  return normalized
}

function optionalBounded(value: unknown, label: string, maximum: number) {
  return value === undefined ? undefined : bounded(value, label, maximum)
}

function evidenceReferences(value: unknown, label: string) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 50) throw new Error(`${label} must be an array of at most 50 strings`)
  return [...new Set(value.map((item, index) => bounded(item, `${label}[${index}]`, 1_024)))]
}

export function currentAttackSnapshotReference(): AttackSnapshotReference | undefined {
  const runtime = readAttackRuntimeSnapshot()
  if (!runtime) return
  return {
    snapshot_id: runtime.manifest.snapshot_id,
    database_sha256: runtime.manifest.database.sha256,
    domains: runtime.manifest.domains.map((item) => ({
      domain: item.domain,
      version: item.version,
      source_sha256: item.sha256,
    })),
  }
}

export function parseAttackAssessment(value: unknown, options: { phase: string }): AttackAssessment {
  const input = record(value, "ATT&CK assessment")
  const applicability = bounded(input.applicability, "ATT&CK applicability", 40) as AttackApplicability
  if (!ATTACK_APPLICABILITY.includes(applicability)) {
    throw new Error(`ATT&CK applicability must be one of ${ATTACK_APPLICABILITY.join(", ")}`)
  }
  const review = (
    input.review === undefined ? "NOT_REVIEWED" : bounded(input.review, "ATT&CK review", 40)
  ) as AttackReview
  if (!ATTACK_REVIEW.includes(review)) throw new Error(`ATT&CK review must be one of ${ATTACK_REVIEW.join(", ")}`)
  if (review !== "NOT_REVIEWED" && options.phase !== "verify") {
    throw new Error("only Verify may accept, revise, or reject an ATT&CK assessment")
  }
  const rationale = optionalBounded(input.rationale, "ATT&CK rationale", 2_000)
  const reviewRationale = optionalBounded(input.review_rationale, "ATT&CK review rationale", 2_000)
  if (!Array.isArray(input.mappings) || input.mappings.length > 30) {
    throw new Error("ATT&CK mappings must be an array of at most 30 entries")
  }
  const mappings = input.mappings.map((candidate, index): AttackMappingAssessment => {
    const mapping = record(candidate, `ATT&CK mappings[${index}]`)
    const domain = optionalBounded(mapping.domain, `ATT&CK mappings[${index}].domain`, 40) as AttackDomain | undefined
    if (domain && domain !== "enterprise" && domain !== "mobile" && domain !== "ics") {
      throw new Error(`ATT&CK mappings[${index}].domain is invalid`)
    }
    return {
      attack_id: bounded(mapping.attack_id, `ATT&CK mappings[${index}].attack_id`, 100),
      ...(mapping.stix_id === undefined
        ? {}
        : { stix_id: bounded(mapping.stix_id, `ATT&CK mappings[${index}].stix_id`, 300) }),
      ...(domain ? { domain } : {}),
      rationale: bounded(mapping.rationale, `ATT&CK mappings[${index}].rationale`, 2_000),
      evidence_refs: evidenceReferences(mapping.evidence_refs, `ATT&CK mappings[${index}].evidence_refs`),
    }
  })
  if (applicability === "UNASSESSED" && (mappings.length > 0 || rationale || review !== "NOT_REVIEWED")) {
    throw new Error("UNASSESSED ATT&CK state cannot contain mappings, rationale, or a review")
  }
  if (applicability === "APPLICABLE" && mappings.length === 0) {
    throw new Error("APPLICABLE ATT&CK assessment requires at least one mapping")
  }
  if ((applicability === "NOT_APPLICABLE" || applicability === "UNAVAILABLE") && !rationale) {
    throw new Error(`${applicability} ATT&CK assessment requires a rationale`)
  }
  if ((review === "ACCEPTED" || review === "REVISED") && applicability !== "APPLICABLE") {
    throw new Error(`${review} ATT&CK review requires APPLICABLE mappings`)
  }
  if (review !== "NOT_REVIEWED" && !reviewRationale) {
    throw new Error(`${review} ATT&CK review requires review_rationale`)
  }
  const snapshot = currentAttackSnapshotReference()
  return {
    applicability,
    ...(rationale ? { rationale } : {}),
    mappings,
    ...(snapshot ? { snapshot } : {}),
    review,
    ...(reviewRationale ? { review_rationale: reviewRationale } : {}),
  }
}

export function attackAssessmentInputSchema(options: { readonly allowReview?: boolean } = {}) {
  return {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      applicability: {
        type: "string" as const,
        enum: [...ATTACK_APPLICABILITY],
        description:
          "UNASSESSED is the empty initial state; APPLICABLE requires mappings; NOT_APPLICABLE and UNAVAILABLE require rationale.",
      },
      rationale: {
        type: "string" as const,
        minLength: 1,
        maxLength: 2_000,
        pattern: "\\S",
        description: "Assessment-level rationale. Required for NOT_APPLICABLE and UNAVAILABLE.",
      },
      mappings: {
        type: "array" as const,
        maxItems: 30,
        description: "Evidence-backed ATT&CK associations. APPLICABLE requires at least one; UNASSESSED requires none.",
        items: {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            attack_id: {
              type: "string" as const,
              minLength: 1,
              maxLength: 100,
              description: "Exact ID returned by mitre_attack get.",
            },
            stix_id: {
              type: "string" as const,
              minLength: 1,
              maxLength: 300,
              description: "Exact STIX ID returned by mitre_attack get.",
            },
            domain: {
              type: "string" as const,
              enum: ["enterprise", "mobile", "ics"],
              description: "Domain of the returned object.",
            },
            rationale: {
              type: "string" as const,
              minLength: 1,
              maxLength: 2_000,
              pattern: "\\S",
              description: "Why the observed or hypothesized behavior matches this object.",
            },
            evidence_refs: {
              type: "array" as const,
              maxItems: 50,
              uniqueItems: true,
              items: { type: "string" as const, minLength: 1, maxLength: 1_024, pattern: "\\S" },
              description: "Primary workarea evidence paths supporting this association.",
            },
          },
          required: ["attack_id", "rationale", "evidence_refs"],
        },
      },
      review: {
        type: "string" as const,
        enum: options.allowReview ? [...ATTACK_REVIEW] : ["NOT_REVIEWED"],
        default: "NOT_REVIEWED",
        description: options.allowReview
          ? "Verify may retain NOT_REVIEWED or assign ACCEPTED, REVISED, or REJECTED."
          : "Only NOT_REVIEWED is executable outside Verify.",
      },
      review_rationale: {
        type: "string" as const,
        minLength: 1,
        maxLength: 2_000,
        pattern: "\\S",
        description: "Required whenever Verify assigns a final review state.",
      },
    },
    required: ["applicability", "mappings"],
  }
}
