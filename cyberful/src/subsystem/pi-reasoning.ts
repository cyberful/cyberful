// ── Pi Reasoning Effort Resolution ──────────────────────────────
// Resolves Cyberful's configured reasoning profile into Pi's supported control
//   without emitting provider-unsupported wire values.
// → cyberful/src/config/settings.ts — owns the operator-facing effort setting.
// → cyberful/src/subsystem/pi-agent.ts — applies the plan to every AgentRun.
// @docs/user-guide/settings.md
// ─────────────────────────────────────────────────────────────────

import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai"
import type { Settings } from "@/config/settings"

export interface ReasoningPlan {
  readonly requested: Settings.ReasoningEffort
  readonly transport: ModelThinkingLevel
  readonly effective: ModelThinkingLevel
}

// ── Ultra Is A Portable Maximum Profile ─────────────────────────
// Codex uses `ultra` as a harness profile and maps it to `max` for the model
// request. Cyberful owns its bounded delegation separately, so this resolver
// applies the same provider-effort mapping through Pi without importing another
// orchestration route. Run state retains both values so an operator can
// distinguish configured intent from the value actually sent to the provider.
// ─────────────────────────────────────────────────────────────────
export function resolve(
  requested: Settings.ReasoningEffort,
  model: Model<Api>,
): ReasoningPlan {
  if (!model.reasoning)
    return {
      requested,
      transport: "off",
      effective: "off",
    }

  const effective = clampThinkingLevel(model, requested === "ultra" ? "max" : requested)
  return {
    requested,
    transport: effective,
    effective,
  }
}

export * as PiReasoning from "./pi-reasoning"
