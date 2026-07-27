// ── Persisted Session Runtime Compatibility ──────────────────────
// Separates readable legacy Codex evidence from turns Pi may execute.
// → cyberful/src/session/prompt.ts — enforces the decision before append and run.
// → cyberful/src/session/message-v2.ts — defines the persisted provenance marker.
// ─────────────────────────────────────────────────────────────────

import { MessageV2 } from "./message-v2"

export const LEGACY_CODEX_SUBSYSTEM_ID = ["codex", "cli"].join("-")

export type State = "pi-compatible" | "legacy-complete" | "legacy-active"

/**
 * Classifies the newest active user turn rather than any historical marker.
 *
 * A terminal completion makes the legacy engagement readable and eligible for
 * a new Pi-owned Ask turn. It does not make the old Codex turn executable by Pi.
 */
export function classify(messages: MessageV2.WithParts[]): State {
  const active = MessageV2.active(messages)
  const user = MessageV2.latest(active).user
  if (!user || user.model.subsystemID !== LEGACY_CODEX_SUBSYSTEM_ID) return "pi-compatible"

  const complete = active.some(
    (message) =>
      message.info.role === "assistant" &&
      message.info.parentID === user.id &&
      message.info.finish !== undefined &&
      message.parts.some((part) => part.type === "completion" && part.nextWorkflow === "ask"),
  )
  return complete ? "legacy-complete" : "legacy-active"
}

export function canAppendPiPrompt(state: State) {
  return state !== "legacy-active"
}

export function canExecuteWithPi(state: State) {
  return state === "pi-compatible"
}

export * as SessionRuntimeCompatibility from "./runtime-compatibility"
