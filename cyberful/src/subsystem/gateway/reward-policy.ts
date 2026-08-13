// ── Published Bug Bounty Reward Policy ──────────────────────────
// Stores the official program reward schedule as non-secret workarea policy
//   and exposes validated tier data to finding maturation and reporting.
// → cyberful/src/session/finding.ts — derives per-finding reward snapshots.
// → cyberful/src/subsystem/gateway/server.ts — exposes phase-owned set/get access.
// @docs/user-guide/workflows.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { readFile } from "node:fs/promises"
import { isRecord } from "@/util/record"
import { replaceWorkareaFile } from "@/workarea"

export const REWARD_POLICY_PATH = "raw/policy/rewards.json"

export type RewardPolicyKind = "MONETARY" | "POINTS" | "NON_MONETARY" | "NOT_PUBLISHED" | "UNAVAILABLE"
export type RewardSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"

export interface RewardTier {
  readonly severity: RewardSeverity
  readonly minimum?: number
  readonly maximum?: number
  readonly currency?: string
  readonly description?: string
}

export interface RewardGroup {
  readonly id: string
  readonly label: string
  readonly assets: readonly string[]
  readonly tiers: readonly RewardTier[]
}

export interface RewardPolicy {
  readonly version: 1
  readonly revision: string
  readonly updated_at: string
  readonly kind: RewardPolicyKind
  readonly source: {
    readonly url: string
    readonly observed_at: string
    readonly title?: string
  }
  readonly groups: readonly RewardGroup[]
  readonly note?: string
}

const kinds = new Set<RewardPolicyKind>([
  "MONETARY",
  "POINTS",
  "NON_MONETARY",
  "NOT_PUBLISHED",
  "UNAVAILABLE",
])
const severities = new Set<RewardSeverity>(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"])

function text(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) throw new Error(`${label} is invalid`)
  return normalized
}

function optionalText(value: unknown, label: string, maximum: number) {
  return value === undefined ? undefined : text(value, label, maximum)
}

function timestamp(value: unknown, label: string) {
  const normalized = text(value, label, 100)
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(`${label} must be an ISO timestamp`)
  return new Date(normalized).toISOString()
}

function source(value: unknown): RewardPolicy["source"] {
  if (!isRecord(value)) throw new Error("reward policy source must be an object")
  const url = new URL(text(value.url, "reward policy source.url", 2_000))
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("reward policy source.url must use HTTP(S)")
  const title = optionalText(value.title, "reward policy source.title", 300)
  return {
    url: url.toString(),
    observed_at: timestamp(value.observed_at, "reward policy source.observed_at"),
    ...(title ? { title } : {}),
  }
}

function boundedAmount(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000_000)
    throw new Error(`${label} must be a finite non-negative number`)
  return value
}

function tier(value: unknown, index: number, kind: RewardPolicyKind): RewardTier {
  if (!isRecord(value)) throw new Error(`tiers[${index}] must be an object`)
  if (!severities.has(value.severity as RewardSeverity)) throw new Error(`tiers[${index}].severity is invalid`)
  const description = optionalText(value.description, `tiers[${index}].description`, 1_000)
  if (kind !== "MONETARY" && kind !== "POINTS")
    return { severity: value.severity as RewardSeverity, ...(description ? { description } : {}) }
  const minimum = boundedAmount(value.minimum, `tiers[${index}].minimum`)
  const maximum = boundedAmount(value.maximum, `tiers[${index}].maximum`)
  if (maximum < minimum) throw new Error(`tiers[${index}].maximum must be greater than or equal to minimum`)
  const currency =
    kind === "MONETARY" ? text(value.currency, `tiers[${index}].currency`, 16).toUpperCase() : undefined
  return {
    severity: value.severity as RewardSeverity,
    minimum,
    maximum,
    ...(currency ? { currency } : {}),
    ...(description ? { description } : {}),
  }
}

function group(value: unknown, index: number, kind: RewardPolicyKind): RewardGroup {
  if (!isRecord(value)) throw new Error(`groups[${index}] must be an object`)
  if (!Array.isArray(value.assets) || !Array.isArray(value.tiers))
    throw new Error(`groups[${index}] assets and tiers must be arrays`)
  const tiers = value.tiers.map((candidate, tierIndex) => tier(candidate, tierIndex, kind))
  if (new Set(tiers.map((candidate) => candidate.severity)).size !== tiers.length)
    throw new Error(`groups[${index}] contains duplicate severity tiers`)
  return {
    id: text(value.id, `groups[${index}].id`, 100),
    label: text(value.label, `groups[${index}].label`, 300),
    assets: value.assets.map((asset, assetIndex) => text(asset, `groups[${index}].assets[${assetIndex}]`, 500)),
    tiers,
  }
}

export function parseRewardPolicy(value: unknown): RewardPolicy {
  if (!isRecord(value) || value.version !== 1 || !kinds.has(value.kind as RewardPolicyKind))
    throw new Error("reward policy is invalid")
  if (!Array.isArray(value.groups)) throw new Error("reward policy groups must be an array")
  const kind = value.kind as RewardPolicyKind
  const groups = value.groups.map((candidate, index) => group(candidate, index, kind))
  if (new Set(groups.map((candidate) => candidate.id)).size !== groups.length)
    throw new Error("reward policy group IDs must be unique")
  if ((kind === "MONETARY" || kind === "POINTS") && groups.length === 0)
    throw new Error(`${kind} reward policy requires at least one group`)
  if ((kind === "NOT_PUBLISHED" || kind === "UNAVAILABLE") && groups.length > 0)
    throw new Error(`${kind} reward policy cannot contain reward groups`)
  const note = optionalText(value.note, "reward policy note", 2_000)
  return {
    version: 1,
    revision: text(value.revision, "reward policy revision", 100),
    updated_at: timestamp(value.updated_at, "reward policy updated_at"),
    kind,
    source: source(value.source),
    groups,
    ...(note ? { note } : {}),
  }
}

export async function readRewardPolicy(workarea: string): Promise<RewardPolicy | undefined> {
  const content = await readFile(path.join(workarea, REWARD_POLICY_PATH), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    },
  )
  return content === undefined ? undefined : parseRewardPolicy(JSON.parse(content))
}

export class RewardPolicyStore {
  readonly #workarea: string

  constructor(workarea: string) {
    if (!path.isAbsolute(workarea)) throw new Error("reward policy requires an absolute workarea root")
    this.#workarea = workarea
  }

  get() {
    return readRewardPolicy(this.#workarea)
  }

  async set(args: Record<string, unknown>) {
    const now = new Date().toISOString()
    const policy = parseRewardPolicy({
      version: 1,
      revision: now,
      updated_at: now,
      kind: args.kind,
      source: args.source,
      groups: args.groups ?? [],
      note: args.note,
    })
    await replaceWorkareaFile(this.#workarea, REWARD_POLICY_PATH, `${JSON.stringify(policy, null, 2)}\n`, {
      mode: 0o600,
    })
    return policy
  }
}

const rewardTierSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    severity: { type: "string", enum: ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] },
    minimum: { type: "number", minimum: 0 },
    maximum: { type: "number", minimum: 0 },
    currency: { type: "string" },
    description: { type: "string" },
  },
  required: ["severity"],
}

export const REWARD_POLICY_TOOL_DEF = {
  name: "reward_policy",
  description:
    "Store or read the official Bug Bounty reward schedule. Brief may set it from the supplied official policy; later phases are read-only. Published tiers are context, not payout or acceptance predictions.",
  inputSchema: {
    type: "object" as const,
    oneOf: [
      {
        type: "object" as const,
        additionalProperties: false,
        properties: { action: { type: "string", enum: ["get"] } },
        required: ["action"],
      },
      {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["set"] },
          kind: {
            type: "string",
            enum: ["MONETARY", "POINTS", "NON_MONETARY", "NOT_PUBLISHED", "UNAVAILABLE"],
          },
          source: {
            type: "object",
            additionalProperties: false,
            properties: {
              url: { type: "string" },
              observed_at: { type: "string" },
              title: { type: "string" },
            },
            required: ["url", "observed_at"],
          },
          groups: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                assets: { type: "array", maxItems: 1_000, items: { type: "string" } },
                tiers: { type: "array", maxItems: 5, items: rewardTierSchema },
              },
              required: ["id", "label", "assets", "tiers"],
            },
          },
          note: { type: "string" },
        },
        required: ["action", "kind", "source", "groups"],
      },
    ],
  },
}

export const REWARD_POLICY_READ_TOOL_DEF = {
  name: REWARD_POLICY_TOOL_DEF.name,
  description:
    "Read the official Bug Bounty reward schedule persisted by Brief. Published tiers are context, not payout or acceptance predictions.",
  inputSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: { action: { type: "string", enum: ["get"] } },
    required: ["action"],
  },
}

export * as GatewayRewardPolicy from "./reward-policy"
