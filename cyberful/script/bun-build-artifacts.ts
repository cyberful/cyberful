// ── Bun Build Artifact Cleanup ──────────────────────────────────────
// Removes only Bun's hidden temporary build products so an interrupted
// standalone compilation cannot poison the next invocation.
// → cyberful/script/build.ts — invokes cleanup before and after compilation.
// ────────────────────────────────────────────────────────────────────

import fs from "node:fs"
import path from "node:path"

export function removeBunBuildArtifacts(directory: string) {
  fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(".") && entry.name.endsWith(".bun-build"))
    .forEach((entry) => fs.rmSync(path.join(directory, entry.name), { force: true }))
}
