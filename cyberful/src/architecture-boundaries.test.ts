// ── Architecture Tombstones ─────────────────────────────────────
// Prevents retired compatibility layers from silently returning after the
// Subsystem, Event, and direct TUI capability refactors.
// → cyberful/src/event.ts — exposes the single application event facade.
// → cyberful/src/cli/cmd/tui/feature/builtins.ts — installs host capabilities directly.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import path from "node:path"

const sourceRoot = import.meta.dir

describe("retired architecture boundaries", () => {
  test("removed compatibility modules stay removed", async () => {
    const retiredModules = [
      "bus/bus-event.ts",
      "event-v2-bridge.ts",
      "event-v2.ts",
      "provider/schema.ts",
      "session/event-v2.ts",
      "sync/index.ts",
      "sync/projected-event.test.ts",
      "sync/schema.ts",
      "cli/cmd/tui/feature/command-shim.ts",
      "cli/cmd/tui/feature/internal.ts",
      "cli/cmd/tui/feature/runtime.ts",
    ]

    const existing = await Promise.all(
      retiredModules.map(async (relativePath) => ({
        relativePath,
        exists: await Bun.file(path.join(sourceRoot, relativePath)).exists(),
      })),
    )

    expect(existing.filter((entry) => entry.exists).map((entry) => entry.relativePath)).toEqual([])
  })

  test("active source does not reference retired architecture identifiers", async () => {
    const retiredIdentifiers = [
      ["Event", "V2"].join(""),
      ["TuiFeature", "Runtime"].join(""),
      ["feature", "_enabled"].join(""),
      ["createCommand", "Shim"].join(""),
      ["Provider", "ID"].join(""),
      ["provider", "ID"].join(""),
      ["Provider", "Failure"].join(""),
      ["provider", "_failed"].join(""),
      ["Subsystem", "Provider"].join(""),
    ]
    const matches: string[] = []
    const sourceFiles = new Bun.Glob("**/*.{ts,tsx}")

    for await (const relativePath of sourceFiles.scan({ cwd: sourceRoot, onlyFiles: true })) {
      if (relativePath === "architecture-boundaries.test.ts" || relativePath.startsWith("server/client/gen/")) {
        continue
      }
      const source = await Bun.file(path.join(sourceRoot, relativePath)).text()
      for (const identifier of retiredIdentifiers) {
        if (source.includes(identifier)) matches.push(`${relativePath}: ${identifier}`)
      }
    }

    expect(matches).toEqual([])
  })
})
