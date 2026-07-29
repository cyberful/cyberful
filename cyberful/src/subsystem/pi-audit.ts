// ── Pi Audit Redaction ───────────────────────────────────────────
// Removes credential-shaped values from AgentRun events and durable
// transcripts without changing the tool result seen by the active agent.
// → cyberful/src/subsystem/pi-agent.ts — redacts live audit activities.
// → cyberful/src/subsystem/pi-phase-runtime.ts — redacts durable NDJSON.
// ─────────────────────────────────────────────────────────────────

const SENSITIVE_KEYS = new Set([
  "access",
  "accesstoken",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "env",
  "key",
  "password",
  "privateenv",
  "privategatewayenvironment",
  "refresh",
  "refreshtoken",
  "secret",
  "setcookie",
])

const REDACTED = "[REDACTED]"
const MAX_DEPTH = 32

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll("-", "").replaceAll("_", "")
}

export function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(
      /\b(api[_-]?key|access(?:[_-]?token)?|refresh(?:[_-]?token)?|authorization|password|secret)\b(\s*[:=]\s*)([^\s,;]+)/gi,
      (_match, label: string, separator: string) => `${label}${separator}${REDACTED}`,
    )
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, `$1${REDACTED}@`)
}

function redact(value: unknown, depth: number, secretContainer: boolean): unknown {
  if (depth > MAX_DEPTH) return "[REDACTED:DEPTH_LIMIT]"
  if (typeof value === "string") return secretContainer ? REDACTED : redactText(value)
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, secretContainer))
  if (typeof value !== "object" || value === null) return value

  const source = value as Record<string, unknown>
  const marksSecret = source.secret === true || source.sensitive === true
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    const sensitiveKey = SENSITIVE_KEYS.has(normalizedKey(key))
    const sensitiveValue = marksSecret && ["content", "text", "value"].includes(normalizedKey(key))
    result[key] = sensitiveKey || sensitiveValue ? REDACTED : redact(item, depth + 1, secretContainer)
  }
  return result
}

export function redactValue(value: unknown): unknown {
  return redact(value, 0, false)
}

export * as PiAudit from "./pi-audit"
