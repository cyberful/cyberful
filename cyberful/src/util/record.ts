// ── Plain Record Boundary Guard ──────────────────────────────────
// Narrows unknown object-shaped input while excluding null and arrays before
// callers inspect dynamic JSON or protocol properties.
// ─────────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
