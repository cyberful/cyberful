// ── Typed Immediate Evaluation ───────────────────────────────────
// Evaluates an expression callback while preserving its inferred return type.
// ─────────────────────────────────────────────────────────────────

export function iife<T>(fn: () => T) {
  return fn()
}
