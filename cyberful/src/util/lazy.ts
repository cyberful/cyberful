// ── Resettable Lazy Value ────────────────────────────────────────
// Memoizes one synchronously computed value and exposes explicit reset and load
// state for environment-sensitive resolvers used by tests and runtime policy.
// → cyberful/src/shell/shell.ts — resets cached shell selection when policy changes.
// ─────────────────────────────────────────────────────────────────

export function lazy<T>(fn: () => T) {
  let state: { loaded: false } | { loaded: true; value: T } = { loaded: false }

  const result = (): T => {
    if (state.loaded) return state.value
    const value = fn()
    state = { loaded: true, value }
    return value
  }

  result.reset = () => {
    state = { loaded: false }
  }

  result.loaded = () => state.loaded

  return result
}
