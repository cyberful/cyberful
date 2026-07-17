// ── TUI Working Directory Context ────────────────────────────────
// Supplies the current working directory as an overridable Effect reference for
//   configuration resolution and deterministic tests.
// ─────────────────────────────────────────────────────────────────

import { Context } from "effect"

export const CurrentWorkingDirectory = Context.Reference<string>("CurrentWorkingDirectory", {
  defaultValue: () => process.cwd(),
})
