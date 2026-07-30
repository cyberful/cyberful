// ── Phase Budget Clock ──────────────────────────────────────────
// Owns one phase's active-execution deadline, overlapping approval and retry
//   suspensions, retry compensation cap, and closeout timing projection.
// → cyberful/src/subsystem/phase-runner.ts — creates one clock per phase.
// → cyberful/src/subsystem/pi-agent.ts — pauses AgentRun timers through this clock.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

export type SuspensionCause = "approval" | "provider_retry"

export interface Snapshot {
  readonly pending: boolean
  readonly count: number
  readonly causes: Readonly<Record<SuspensionCause, number>>
  readonly deadlineAt: number
  readonly pausedMs: number
  readonly approvalWaitMs: number
  readonly retryWaitMs: number
  readonly retryCompensationMs: number
  readonly retryCompensationCapMs: number
  readonly retryCompensationCapReached: boolean
}

export interface Controller {
  readonly wait: <T>(cause: SuspensionCause, operation: () => Promise<T>) => Promise<T>
  readonly suspend: (cause: SuspensionCause) => () => void
  readonly subscribe: (listener: (snapshot: Snapshot) => void) => () => void
  readonly snapshot: () => Snapshot
  readonly deadlineAt: () => number
  readonly pausedMs: (cause?: SuspensionCause) => number
  readonly close: () => void
}

interface Options {
  readonly deadlineAt: number
  readonly retryCompensationCapMs: number
  readonly now?: () => number
}

// ── Overlapping Waits Extend The Deadline Only Once ─────────────
// A provider retry and a human approval can overlap, as can several delegated
// retries. The clock accumulates the union of all effective suspension
// intervals for its deadline while retaining per-cause durations for audit.
// Retry time stops extending the deadline at its configured cap; approval time
// remains suspended because it is outside autonomous execution control.
//
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────
export function create(options: Options): Controller {
  const now = options.now ?? Date.now
  const listeners = new Set<(snapshot: Snapshot) => void>()
  const counts: Record<SuspensionCause, number> = { approval: 0, provider_retry: 0 }
  const retryCompensationCapMs = Math.max(0, options.retryCompensationCapMs)
  let lastObservedAt = now()
  let totalPausedMs = 0
  let approvalWaitMs = 0
  let retryWaitMs = 0
  let retryCompensationMs = 0
  let capTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const advance = (observedAt = now()) => {
    const elapsedMs = Math.max(0, observedAt - lastObservedAt)
    if (elapsedMs === 0) return

    const retryCreditMs =
      counts.provider_retry > 0
        ? Math.min(elapsedMs, Math.max(0, retryCompensationCapMs - retryCompensationMs))
        : 0
    if (counts.provider_retry > 0) retryWaitMs += elapsedMs
    if (counts.approval > 0) {
      totalPausedMs += elapsedMs
      approvalWaitMs += elapsedMs
    } else if (retryCreditMs > 0) {
      totalPausedMs += retryCreditMs
    }
    retryCompensationMs += retryCreditMs
    lastObservedAt = observedAt
  }

  const current = (): Snapshot => {
    advance()
    const retryEffective =
      counts.provider_retry > 0 && retryCompensationMs < retryCompensationCapMs
    const pending = counts.approval > 0 || retryEffective
    return {
      pending,
      count: counts.approval + counts.provider_retry,
      causes: { ...counts },
      deadlineAt: options.deadlineAt + totalPausedMs,
      pausedMs: totalPausedMs,
      approvalWaitMs,
      retryWaitMs,
      retryCompensationMs,
      retryCompensationCapMs,
      retryCompensationCapReached:
        retryCompensationCapMs > 0 && retryCompensationMs >= retryCompensationCapMs,
    }
  }

  const scheduleCap = () => {
    if (capTimer !== undefined) clearTimeout(capTimer)
    capTimer = undefined
    if (closed || counts.provider_retry === 0) return
    const remainingMs = retryCompensationCapMs - retryCompensationMs
    if (remainingMs <= 0) return
    capTimer = setTimeout(() => {
      capTimer = undefined
      publish()
    }, remainingMs)
  }

  const publish = () => {
    const snapshot = current()
    scheduleCap()
    for (const listener of listeners) listener(snapshot)
  }

  const suspend = (cause: SuspensionCause) => {
    if (closed) throw new Error("phase budget clock is closed")
    advance()
    counts[cause] += 1
    publish()
    let active = true
    return () => {
      if (!active) return
      active = false
      advance()
      if (counts[cause] <= 0) throw new Error(`phase budget suspension '${cause}' count underflow`)
      counts[cause] -= 1
      publish()
    }
  }

  const wait = async <T>(cause: SuspensionCause, operation: () => Promise<T>): Promise<T> => {
    const release = suspend(cause)
    try {
      return await operation()
    } finally {
      release()
    }
  }

  const subscribe = (listener: (snapshot: Snapshot) => void) => {
    listeners.add(listener)
    listener(current())
    return () => listeners.delete(listener)
  }

  const snapshot = () => current()
  const deadlineAt = () => current().deadlineAt
  const pausedMs = (cause?: SuspensionCause) => {
    const value = current()
    if (cause === "approval") return value.approvalWaitMs
    if (cause === "provider_retry") return value.retryWaitMs
    return value.pausedMs
  }
  const close = () => {
    if (closed) return
    advance()
    closed = true
    if (capTimer !== undefined) clearTimeout(capTimer)
    capTimer = undefined
    listeners.clear()
  }

  return { wait, suspend, subscribe, snapshot, deadlineAt, pausedMs, close }
}

export * as SubsystemPhaseBudgetClock from "./phase-budget-clock"
