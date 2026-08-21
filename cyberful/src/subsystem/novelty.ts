// ── Adaptive Novelty Contract ──────────────────────────────────
// Selects the qualitative contrarian pass or Bug Bounty's structurally checked
//   portfolio mode without introducing numeric quotas or automatic ranking.
// → cyberful/src/subsystem/gateway/hypothesis-registry.ts — records and enforces phase synthesis.
// @docs/user-guide/workflows.md
// ─────────────────────────────────────────────────────────────────

import { isRecord } from "@/util/record"

export const CONTRACT_ENV = "CYBERFUL_SUBSYSTEM_NOVELTY_CONTRACT"

export type Mode = "qualitative" | "bounty-portfolio"

export interface Contract {
  readonly required: true
  readonly mode: Mode
}

export interface Resolution {
  readonly contract?: Contract
  readonly warning?: string
}

export function resolve(budgets: unknown, phase: string): Resolution {
  if (!isRecord(budgets) || !isRecord(budgets.$novelty) || budgets.$novelty[phase] === undefined) return {}
  const candidate = budgets.$novelty[phase]
  if (candidate === true) return { contract: { required: true, mode: "qualitative" } }
  if (isRecord(candidate) && candidate.required === true) {
    const mode = candidate.mode ?? "qualitative"
    if (mode === "qualitative" || mode === "bounty-portfolio") return { contract: { required: true, mode } }
  }
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
  const mode = parsed.mode ?? "qualitative"
  if (mode !== "qualitative" && mode !== "bounty-portfolio") throw new Error(`${CONTRACT_ENV} is invalid`)
  return { required: true, mode }
}

export * as SubsystemNovelty from "./novelty"
