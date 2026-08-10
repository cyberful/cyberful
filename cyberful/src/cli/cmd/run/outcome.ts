// ── One-Shot Run Outcome ────────────────────────────────────
// Interprets the authoritative completion part returned by a one-shot session
//   so shell automation cannot mistake an incomplete workflow for success.
// → cyberful/src/cli/cmd/run.ts — owns the process exit status.
// → cyberful/src/session/message-v2.ts — defines completion outcomes.
// ────────────────────────────────────────────────────────────────

import { isRecord } from "@/util/record"

export function completionExitCode(value: unknown): 0 | 1 | undefined {
  if (!isRecord(value) || !Array.isArray(value.parts)) return
  const completion = value.parts.findLast(
    (part): part is Record<string, unknown> => isRecord(part) && part.type === "completion",
  )
  if (!completion) return
  if (completion.outcome === "success" || completion.outcome === "warning") return 0
  if (completion.outcome === "blocked" || completion.outcome === "failed") return 1
}
