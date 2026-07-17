// ── Built-In Policy Location ─────────────────────────────────────
// Exposes the source-tree location of Cyberful's bundled personas, skills,
// instructions, and configuration for bootstrap and release packaging.
// → cyberful/builtin/cyberful.json — defines the root built-in policy.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"

export const DIR = path.resolve(import.meta.dir, "../builtin")
