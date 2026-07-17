// ── Terminal Promise Observation ────────────────────────────────
// Connects short asynchronous work launched by synchronous callbacks to explicit
//   fulfillment, failure, and settlement handlers without consuming its result.
// Observer failures are rethrown on the microtask queue instead of disappearing.
// ─────────────────────────────────────────────────────────────────

import { errorMessage } from "./error"

export interface PromiseObserver<Value> {
  readonly fulfilled?: (value: Value) => void
  readonly rejected: (error: unknown) => void
  readonly settled?: () => void
}

function invokeObserver(callback: (() => void) | undefined): void {
  if (!callback) return
  try {
    callback()
  } catch (error) {
    queueMicrotask(() => {
      throw error instanceof Error
        ? error
        : new Error(`Promise observer failed: ${errorMessage(error)}`, { cause: error })
    })
  }
}

export function observePromise<Value>(promise: Promise<Value>, observer: PromiseObserver<Value>): void {
  promise.then(
    (value) => {
      invokeObserver(observer.fulfilled ? () => observer.fulfilled?.(value) : undefined)
      invokeObserver(observer.settled)
    },
    (error) => {
      invokeObserver(() => observer.rejected(error))
      invokeObserver(observer.settled)
    },
  )
}
