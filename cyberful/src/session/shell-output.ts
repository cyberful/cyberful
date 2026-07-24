// ── Bounded User-Shell Output ────────────────────────────────────
// Retains only the final window of shell output and makes every truncation
//   visible in the session journal.
// ─────────────────────────────────────────────────────────────────

import { BoundedByteTail } from "@/util/bounded-output"

const SHELL_OUTPUT_LIMIT_BYTES = 512 * 1024

export function createShellOutputTail() {
  return new BoundedByteTail(SHELL_OUTPUT_LIMIT_BYTES)
}

export function renderShellOutput(output: BoundedByteTail) {
  const tail = output.text()
  if (!output.truncated) return tail
  return `[Earlier shell output omitted: ${output.droppedBytes} bytes. Showing the final ${output.limit} bytes.]\n${tail}`
}
