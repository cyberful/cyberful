// ── Engagement Degradation Metadata ──────────────────────────────────────
// Carries the aggregate Expert warning state across the agent-owned middle of a pentest chain.
// The flag lives in user-message metadata so handoffs and continuations preserve it without
// a database migration; a new human objective omits the flag and starts a fresh engagement.
// → cyberful/src/session/prompt.ts — propagates the metadata across phase boundaries.
// ────────────────────────────────────────────────────────────────────

export const METADATA_KEY = "expert_engagement_status"
export const DEGRADED = "completed_with_warnings"

export function isDegraded(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.[METADATA_KEY] === DEGRADED
}

export function metadata(degraded: boolean): Record<string, string> {
  return degraded ? { [METADATA_KEY]: DEGRADED } : {}
}

export * as EngagementStatus from "./engagement-status"
