// ── Architecture Tombstones ─────────────────────────────────────
// Prevents retired compatibility layers and the duplicate direct-interactive UI
// from silently returning after the Pi, Event, and TUI capability refactors.
// → cyberful/src/event.ts — exposes the single application event facade.
// → cyberful/src/subsystem/pi-agent.ts — owns the sole agent runtime.
// → cyberful/src/cli/cmd/tui/feature/builtins.ts — installs host capabilities directly.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import path from "node:path"

const sourceRoot = import.meta.dir

describe("retired architecture boundaries", () => {
  test("standalone builds cannot capture the repository .env", async () => {
    const buildSource = await Bun.file(path.resolve(sourceRoot, "../script/build.ts")).text()

    expect(buildSource).toContain('const embeddedEnv = ""')
    expect(buildSource).not.toContain('path.resolve(dir, "../.env")')
  })

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
      "dependency/codex.ts",
      "session/codex-only-runtime.test.ts",
      "subsystem/codex.ts",
      "subsystem/codex-control.ts",
      "subsystem/fixtures/codex-app-server.ts",
      "cli/cmd/tui/feature/command-shim.ts",
      "cli/cmd/tui/feature/internal.ts",
      "cli/cmd/tui/feature/runtime.ts",
      "cli/cmd/run/demo.ts",
      "cli/cmd/run/footer.ts",
      "cli/cmd/run/runtime.ts",
      "cli/cmd/run/stream.transport.ts",
      "cli/cmd/run/types.ts",
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
      ["Subsystem", "Codex"].join(""),
      ["codex", "-cli"].join(""),
      ["codex", " app-server"].join(""),
      ["fallback", "_server"].join(""),
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
