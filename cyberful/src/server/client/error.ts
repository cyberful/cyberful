// ── Control-Plane Client Error Translation ──────────────────────
// Converts decoded non-success responses into useful Error values only for
// callers that request throwing behavior, preserving tuple-mode response data.
// → cyberful/src/server/client/index.ts — installs the translation hook.
// ─────────────────────────────────────────────────────────────────

import { isRecord } from "@/util/record"

// ── Throwing Preserves Tuple-Mode Error Data ─────────────────────
// Generated clients decode non-success bodies into strings, objects, or empty
// values. Throwing callers need a real Error with a useful message and retain
// the decoded body and status under cause for structured inspection. Tuple-mode
// callers receive the original decoded value unchanged, so enabling translation
// cannot alter their field-level compatibility contract.
// ─────────────────────────────────────────────────────────────────
export function wrapClientError(
  error: unknown,
  response: Response | undefined,
  request: Request | undefined,
  opts: { throwOnError?: boolean } | undefined,
): unknown {
  if (!opts?.throwOnError) return error
  if (error instanceof Error) return error

  // NamedError-shaped responses (the common case for Cyberful 4xx) come
  // through as POJOs — extract a useful message first, then wrap.
  if (isRecord(error) && Object.keys(error).length > 0) {
    const data = isRecord(error.data) ? error.data : undefined
    const message =
      (typeof data?.message === "string" && data.message) ||
      (typeof error.message === "string" && error.message) ||
      (typeof error.name === "string" && error.name) ||
      describe(request, response)
    return new Error(message, { cause: { body: error, status: response?.status } })
  }

  if (typeof error === "string" && error.length > 0) {
    return new Error(error, { cause: { body: error, status: response?.status } })
  }

  // Empty body / network failure / undefined / null / empty object.
  const reason = response ? "(empty response body)" : "network error (no response)"
  return new Error(`Cyberful server ${describe(request, response)}: ${reason}`, {
    cause: { body: error, status: response?.status },
  })
}

function describe(request: Request | undefined, response: Response | undefined) {
  const method = request?.method ?? "?"
  const url = request?.url ?? "?"
  const status = response?.status
  const statusText = response?.statusText
  return `${method} ${url}${status ? " → " + status : ""}${statusText ? " " + statusText : ""}`
}
