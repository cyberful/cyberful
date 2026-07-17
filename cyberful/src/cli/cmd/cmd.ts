// ── Yargs Command Identity ───────────────────────────────────────
// Preserves command-module inference while extending parsed arguments with
//   tokens that follow the double-dash separator.
// ─────────────────────────────────────────────────────────────────

import type { CommandModule } from "yargs"

export type WithDoubleDash<T> = T & { "--"?: string[] }

export function cmd<T, U>(input: CommandModule<T, WithDoubleDash<U>>) {
  return input
}
