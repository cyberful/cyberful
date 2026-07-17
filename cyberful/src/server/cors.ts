// ── Local Request Origin Policy ─────────────────────────────────
// Accepts absent origins, same-host requests, and loopback browser origins
// while rejecting unrelated origins before control-plane request handling.
// → cyberful/src/server/routes/instance/httpapi/server.ts — configures CORS with this policy.
// ─────────────────────────────────────────────────────────────────

export function isAllowedCorsOrigin(input: string | undefined) {
  if (!input) return true
  if (input.startsWith("http://localhost:")) return true
  if (input.startsWith("http://127.0.0.1:")) return true
  return false
}

export function isAllowedRequestOrigin(input: string | undefined, host: string | undefined) {
  if (!input) return true
  if (host && sameHost(input, host)) return true
  return isAllowedCorsOrigin(input)
}

function sameHost(origin: string, host: string) {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
