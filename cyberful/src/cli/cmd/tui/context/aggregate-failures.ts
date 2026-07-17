// ── Parallel Bootstrap Failure Aggregation ───────────────────────
// Converts labeled settled requests into one causal error that preserves every
//   failed endpoint and groups identical reasons instead of losing siblings.
// ─────────────────────────────────────────────────────────────────

import { FormatError } from "@/cli/error"
import { isRecord } from "@/util/record"
export type LabeledSettled = {
  name: string
  result: PromiseSettledResult<unknown>
}

export function aggregateFailures(labeled: LabeledSettled[]): Error | null {
  const failed = labeled.filter(
    (x): x is { name: string; result: PromiseRejectedResult } => x.result.status === "rejected",
  )
  if (failed.length === 0) return null

  const reasons = Array.from(
    failed
      .map((f) => ({ name: f.name, message: reasonMessage(f.result.reason) }))
      .reduce((grouped, failure) => {
        grouped.set(failure.message, [...(grouped.get(failure.message) ?? []), failure.name])
        return grouped
      }, new Map<string, string[]>())
      .entries(),
  )
    .map(([message, names]) =>
      names.length === 1 ? `${names[0]}: ${message}` : `${message}\nAffected startup requests: ${names.join(", ")}`,
    )
    .join("; ")
  const summary = `${failed.length} of ${labeled.length} requests failed: ${reasons}`
  const err = new Error(summary)
  err.cause = { failures: failed.map((f) => ({ name: f.name, reason: f.result.reason })) }
  return err
}

function reasonMessage(reason: unknown): string {
  const formatted = FormatError(reason)
  if (formatted) return formatted

  if (reason instanceof Error) return reason.message
  if (typeof reason === "string") return reason
  if (isRecord(reason)) {
    if (typeof reason.message === "string") return reason.message
    if (typeof reason.name === "string") return reason.name
  }
  return String(reason)
}
