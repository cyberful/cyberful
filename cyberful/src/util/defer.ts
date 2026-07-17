// ── Awaited Scope Cleanup ────────────────────────────────────────
// Adapts synchronous or asynchronous cleanup into an AsyncDisposable so an
// `await using` scope cannot silently detach a rejected cleanup promise.
// ─────────────────────────────────────────────────────────────────

export function defer(fn: () => void | Promise<void>): AsyncDisposable {
  return {
    [Symbol.asyncDispose]() {
      return Promise.resolve(fn())
    },
  }
}
