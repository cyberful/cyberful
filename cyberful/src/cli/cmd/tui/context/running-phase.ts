// ── Live Phase Header State ──────────────────────────────
// Tracks the active phase and its first observed timestamp for the composer
//   status header, including recovery when the opening event was missed.
// → cyberful/src/cli/cmd/tui/context/sync.tsx — folds streamed activity into this state.
// → cyberful/src/cli/cmd/tui/component/prompt/status-header.tsx — presents the state.
// ────────────────────────────────

export type RunningPhase = {
  phase: string
  lastKind?: string
  startedAt: number
}

export type RunningPhaseActivity = {
  phase: string
  kind: string
  timestamp: number
}

// ── Missing Starts Recover From The First Observable Activity ──────
// Phase activity is transient and the TUI may attach after the opening frame.
// The first frame seen for a phase therefore establishes its local start time,
// while later frames preserve that timestamp. A phase identity change starts a
// fresh clock even when its explicit start was missed, and end always clears the
// state so completed work cannot leave a stale busy header behind.
// ────────────────────────────────
export function foldRunningPhase(current: RunningPhase | undefined, activity: RunningPhaseActivity) {
  if (activity.kind === "end") return undefined
  if (activity.kind === "start" || !current || current.phase !== activity.phase)
    return {
      phase: activity.phase,
      startedAt: activity.timestamp,
      ...(activity.kind === "progress" || activity.kind === "status" || activity.kind === "start"
        ? {}
        : { lastKind: activity.kind }),
    }
  if (activity.kind === "progress" || activity.kind === "status") return current
  return { ...current, lastKind: activity.kind }
}
