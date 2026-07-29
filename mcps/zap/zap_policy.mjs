// ── ZAP API Request Normalization ───────────────────────────────────
// Canonicalizes API catalog keys and flat query parameters for the bridge.
// Authorization and engagement scope remain agent-owned; this module does not
// filter ZAP operations, destinations, redirects, or add-on capabilities.
// → mcps/zap/zap_bridge.mjs — exposes the complete discovered API catalog.
// ────────────────────────────────────────────────────────────────────

export function operationKey(component, type, operation) {
  return `${component}:${type}:${operation}`
}

export function apiParameters(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (item === undefined || item === null) return []
      if (Array.isArray(item)) {
        if (item.some((entry) => typeof entry === "object" && entry !== null)) {
          throw new Error(`ZAP API parameter ${key} must be flat`)
        }
        return [[key, item.join(",")]]
      }
      if (typeof item === "object") throw new Error(`ZAP API parameter ${key} must be flat`)
      return [[key, typeof item === "string" ? item : String(item)]]
    }),
  )
}
