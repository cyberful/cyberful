// ── Configuration Directory Contract Tests ──────────────────────
// Verifies that routine config discovery uses global definitions plus only the
// explicit override, without reviving hidden project configuration directories.
// → cyberful/src/config/paths.ts — implements the directory precedence under test.
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Global } from "@/global"
import * as ConfigPaths from "./paths"

const originalConfigDir = process.env.CYBERFUL_CONFIG_DIR

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CYBERFUL_CONFIG_DIR
  else process.env.CYBERFUL_CONFIG_DIR = originalConfigDir
})

describe("ConfigPaths.directories", () => {
  test("does not discover hidden project configuration directories", () => {
    delete process.env.CYBERFUL_CONFIG_DIR
    expect(Effect.runSync(ConfigPaths.directories("/repo/project", "/repo"))).toEqual([Global.Path.config])
  })

  test("includes only the explicit config directory alongside global config", () => {
    process.env.CYBERFUL_CONFIG_DIR = "/opt/cyberful/builtin"
    expect(Effect.runSync(ConfigPaths.directories("/repo/project", "/repo"))).toEqual([
      Global.Path.config,
      "/opt/cyberful/builtin",
    ])
  })
})
