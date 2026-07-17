// ── npm Configuration Boundary Tests ────────────────────────────
// Protects the routine custom-registry workflow while isolating npm from the
// developer's home configuration and validating the reduced flat result.
// → cyberful/src/dependency/npm-config.ts — loads and narrows npm's internal API.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { NpmConfig } from "./npm-config"

test("a project registry overrides isolated npm defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-npm-config-"))
  const environmentKeys = ["HOME", "USERPROFILE", "npm_config_userconfig", "npm_config_globalconfig"] as const
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]))
  const userConfig = path.join(root, "user.npmrc")
  const globalConfig = path.join(root, "global.npmrc")
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.npm_config_userconfig = userConfig
  process.env.npm_config_globalconfig = globalConfig

  try {
    await Promise.all([
      Bun.write(userConfig, ""),
      Bun.write(globalConfig, ""),
      Bun.write(path.join(root, ".npmrc"), "registry=https://registry.example.test/\n"),
    ])

    const config = await Effect.runPromise(NpmConfig.load(root))
    expect(config.registry).toBe("https://registry.example.test/")
    expect(await Effect.runPromise(NpmConfig.registry(root))).toBe("https://registry.example.test")
  } finally {
    for (const key of environmentKeys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      if (value !== undefined) process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})
