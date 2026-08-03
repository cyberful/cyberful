// ── Adaptive Bug Bounty Novelty Contract ───────────────────────
// Enables a qualitative contrarian pass without quotas, counters, or numeric
//   handoff gates that could reward administrative work over target research.
// → cyberful/src/subsystem/gateway/hypothesis-registry.ts — records and enforces phase synthesis.
// @docs/user-guide/workflows.md
// ─────────────────────────────────────────────────────────────────

import { isRecord } from "@/util/record"

export const CONTRACT_ENV = "CYBERFUL_SUBSYSTEM_NOVELTY_CONTRACT"

export interface Contract {
  readonly required: true
}

export interface Resolution {
  readonly contract?: Contract
  readonly warning?: string
}

export function resolve(budgets: unknown, phase: string): Resolution {
  if (!isRecord(budgets) || !isRecord(budgets.$novelty) || budgets.$novelty[phase] === undefined) return {}
  const candidate = budgets.$novelty[phase]
  if (candidate === true || (isRecord(candidate) && candidate.required === true)) return { contract: { required: true } }
  return { warning: `Novelty contract '${phase}' is invalid and was disabled.` }
}

export function parseEnvironment(value = process.env[CONTRACT_ENV]?.trim()): Contract | undefined {
  if (!value) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`${CONTRACT_ENV} must contain valid JSON`, { cause: error })
  }
  if (!isRecord(parsed) || parsed.required !== true) throw new Error(`${CONTRACT_ENV} is invalid`)
  return { required: true }
}

export * as SubsystemNovelty from "./novelty"
