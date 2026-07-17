// ── Promise Observation Deadline ─────────────────────────────────
// Rejects observation after a validated deadline; the caller remains responsible
// for aborting the underlying operation when a timeout occurs.
// → cyberful/src/cli/cmd/tui/thread.ts — terminates a worker after shutdown exceeds this deadline.
// ─────────────────────────────────────────────────────────────────

export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> {
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 2_147_483_647) {
    return Promise.reject(new Error("Timeout must be an integer between 1 and 2147483647 milliseconds"))
  }
  let timeout: NodeJS.Timeout
  return Promise.race([
    promise.finally(() => {
      clearTimeout(timeout)
    }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(label ?? `Operation timed out after ${ms}ms`))
      }, ms)
    }),
  ])
}
