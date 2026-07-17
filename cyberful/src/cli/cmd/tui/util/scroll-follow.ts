// ── Idle Scroll Following ───────────────────────────────────────
// Tracks a detached live transcript and requests bottom following after the
//   reader leaves its position unchanged for a bounded idle period.
// → cyberful/src/cli/cmd/tui/routes/session/index.tsx — applies the decision to the session scrollbox.
// ─────────────────────────────────────────────────────────────────

export const SCROLL_FOLLOW_IDLE_MS = 60_000

type Observation = {
  active: boolean
  detached: boolean
  now: number
  scrollTop: number
}

// ── Movement Restarts The Reader's Idle Window ──────────────────
// OpenTUI exposes the current scroll position but no scroll event, so the session
// route samples that position while it updates the jump-to-bottom affordance.
// A changed detached position conservatively counts as reader activity and starts
// a fresh idle window. Attached or inactive transcripts clear all retained state,
// preventing an old deadline from pulling a later session view to the bottom.
// ─────────────────────────────────────────────────────────────────
export class IdleScrollFollow {
  private idleSince: number | undefined
  private scrollTop: number | undefined

  constructor(private readonly idleMs = SCROLL_FOLLOW_IDLE_MS) {}

  observe(observation: Observation): boolean {
    if (!observation.active || !observation.detached) {
      this.idleSince = undefined
      this.scrollTop = undefined
      return false
    }

    if (this.scrollTop !== observation.scrollTop) {
      this.idleSince = observation.now
      this.scrollTop = observation.scrollTop
      return false
    }

    this.idleSince ??= observation.now
    if (observation.now - this.idleSince < this.idleMs) return false

    this.idleSince = observation.now
    return true
  }
}
