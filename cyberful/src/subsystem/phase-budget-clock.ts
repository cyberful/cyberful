// ── Phase Budget Clock ──────────────────────────────────────────
// Owns one phase's active-execution deadline, overlapping wait suspensions,
// idempotent recovery extensions, and closeout timing projection.
// → cyberful/src/subsystem/phase-runner.ts — creates one clock per phase.
// → cyberful/src/subsystem/pi-agent.ts — pauses AgentRun timers through this clock.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

export type SuspensionCause = "approval" | "provider_retry" | "target_cooldown"

export interface Snapshot {
  readonly pending: boolean
  readonly count: number
  readonly causes: Readonly<Record<SuspensionCause, number>>
  readonly deadlineAt: number
  readonly pausedMs: number
  readonly approvalWaitMs: number
  readonly retryWaitMs: number
  readonly targetCooldownWaitMs: number
  readonly retryCompensationMs: number
  readonly retryCompensationCapMs: number
  readonly retryCompensationCapReached: boolean
  readonly recoveryExtensionMs: number
}

export interface Controller {
  readonly wait: <T>(cause: SuspensionCause, operation: () => Promise<T>) => Promise<T>
  readonly suspend: (cause: SuspensionCause) => () => void
  readonly subscribe: (listener: (snapshot: Snapshot) => void) => () => void
  readonly snapshot: () => Snapshot
  readonly deadlineAt: () => number
  readonly pausedMs: (cause?: SuspensionCause) => number
  readonly grantRecoveryExtension: (chainID: string, extensionMs: number) => boolean
  readonly close: () => void
}

interface Options {
  readonly deadlineAt: number
  readonly retryCompensationCapMs: number
  readonly initialApprovalWaitMs?: number
  readonly initialRetryWaitMs?: number
  readonly initialTargetCooldownWaitMs?: number
  readonly initialRetryCompensationMs?: number
  readonly initialRecoveryExtensionMs?: number
  readonly recoveredChainIDs?: readonly string[]
  readonly now?: () => number
}

// ── Overlapping Waits Extend The Deadline Only Once ─────────────
// A provider retry, human approval, and target cooldown can overlap, as can
// several delegated retries. The clock accumulates the union of all effective
// suspension intervals for its deadline while retaining per-cause durations
// for audit. Retry time stops extending the deadline at its configured cap;
// approval and target cooldown remain suspended because neither is productive
// autonomous execution time.
//
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────
export function create(options: Options): Controller {
  const now = options.now ?? Date.now
  const listeners = new Set<(snapshot: Snapshot) => void>()
  const counts: Record<SuspensionCause, number> = { approval: 0, provider_retry: 0, target_cooldown: 0 }
  const retryCompensationCapMs = Math.max(0, options.retryCompensationCapMs)
  let lastObservedAt = now()
  let totalPausedMs = 0
  let approvalWaitMs = Math.max(0, options.initialApprovalWaitMs ?? 0)
  let retryWaitMs = Math.max(0, options.initialRetryWaitMs ?? 0)
  let targetCooldownWaitMs = Math.max(0, options.initialTargetCooldownWaitMs ?? 0)
  let retryCompensationMs = Math.min(
    retryCompensationCapMs,
    Math.max(0, options.initialRetryCompensationMs ?? 0),
  )
  let recoveryExtensionMs = Math.max(0, options.initialRecoveryExtensionMs ?? 0)
  const recoveredChainIDs = new Set(options.recoveredChainIDs ?? [])
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
    if (counts.approval > 0) approvalWaitMs += elapsedMs
    if (counts.target_cooldown > 0) targetCooldownWaitMs += elapsedMs
    if (counts.approval > 0 || counts.target_cooldown > 0) {
      totalPausedMs += elapsedMs
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
    const pending = counts.approval > 0 || counts.target_cooldown > 0 || retryEffective
    return {
      pending,
      count: counts.approval + counts.provider_retry + counts.target_cooldown,
      causes: { ...counts },
      deadlineAt: options.deadlineAt + totalPausedMs + recoveryExtensionMs,
      pausedMs: totalPausedMs,
      approvalWaitMs,
      retryWaitMs,
      targetCooldownWaitMs,
      retryCompensationMs,
      retryCompensationCapMs,
      retryCompensationCapReached:
        retryCompensationCapMs > 0 && retryCompensationMs >= retryCompensationCapMs,
      recoveryExtensionMs,
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
    if (cause === "target_cooldown") return value.targetCooldownWaitMs
    return value.pausedMs
  }

  // ── Recovery Time Is A Named One-Shot Grant ────────────────────
  // A recovery may span a replacement AgentRun or a fresh phase owner, so a
  // caller-provided chain identifier is the durable unit of admission. The
  // clock applies a finite non-negative extension only on the first grant and
  // publishes the new deadline immediately, allowing every owned timer to
  // restart from the same authority without compounding descendant bonuses.
  // ────────────────────────────────────────────────────────────────
  const grantRecoveryExtension = (chainID: string, extensionMs: number): boolean => {
    if (closed) throw new Error("phase budget clock is closed")
    const normalizedChainID = chainID.trim()
    if (!normalizedChainID) throw new Error("recovery chain id is empty")
    if (!Number.isSafeInteger(extensionMs) || extensionMs < 0)
      throw new Error("recovery extension must be a non-negative safe integer")
    if (recoveredChainIDs.has(normalizedChainID)) return false
    recoveredChainIDs.add(normalizedChainID)
    recoveryExtensionMs += extensionMs
    publish()
    return true
  }
  const close = () => {
    if (closed) return
    advance()
    closed = true
    if (capTimer !== undefined) clearTimeout(capTimer)
    capTimer = undefined
    listeners.clear()
  }

  return { wait, suspend, subscribe, snapshot, deadlineAt, pausedMs, grantRecoveryExtension, close }
}

export * as SubsystemPhaseBudgetClock from "./phase-budget-clock"
