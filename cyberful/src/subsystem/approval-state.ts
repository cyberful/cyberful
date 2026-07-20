// ── Phase Approval Suspension State ──────────────────────────────
// Counts blocking human decisions for one phase and exposes a single transition
//   stream that freezes and resumes its process budget without global state.
// → cyberful/src/subsystem/phase-runner.ts — owns one controller per phase.
// → cyberful/src/subsystem/cli.ts — suspends the active process group and timer.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

export interface Snapshot {
  pending: boolean
  count: number
}

export interface Controller {
  readonly wait: <T>(operation: () => Promise<T>) => Promise<T>
  readonly subscribe: (listener: (snapshot: Snapshot) => void) => () => void
  readonly snapshot: () => Snapshot
  readonly pausedMs: () => number
}

interface Options {
  now?: () => number
}

// ── Only Boundary Transitions Move The Phase Clock ───────────────
// Native Codex input and gateway questions can overlap, so a boolean cannot own
// suspension safely. The first pending request starts one paused interval and
// the last settlement closes it; intermediate requests only change the count.
// Subscribers receive the current state immediately, preventing a process that
// registers after a fast request from accidentally running against its budget.
// ─────────────────────────────────────────────────────────────────
export function create(options: Options = {}): Controller {
  const now = options.now ?? performance.now.bind(performance)
  const listeners = new Set<(snapshot: Snapshot) => void>()
  let count = 0
  let pausedAt: number | undefined
  let accumulatedMs = 0

  const snapshot = (): Snapshot => ({ pending: count > 0, count })
  const publish = () => {
    const current = snapshot()
    for (const listener of listeners) listener(current)
  }

  const enter = () => {
    count += 1
    if (count !== 1) return
    pausedAt = now()
    publish()
  }

  const leave = () => {
    if (count <= 0) throw new Error("approval suspension count underflow")
    count -= 1
    if (count !== 0) return
    if (pausedAt !== undefined) accumulatedMs += Math.max(0, now() - pausedAt)
    pausedAt = undefined
    publish()
  }

  const wait = async <T>(operation: () => Promise<T>): Promise<T> => {
    enter()
    try {
      return await operation()
    } finally {
      leave()
    }
  }

  const subscribe = (listener: (snapshot: Snapshot) => void) => {
    listeners.add(listener)
    listener(snapshot())
    return () => listeners.delete(listener)
  }

  const pausedMs = () => accumulatedMs + (pausedAt === undefined ? 0 : Math.max(0, now() - pausedAt))

  return { wait, subscribe, snapshot, pausedMs }
}

export * as SubsystemApprovalState from "./approval-state"
