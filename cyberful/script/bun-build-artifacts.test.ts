// ── Bun Artifact Cleanup Contract ───────────────────────────────────
// Proves interrupted builds remove Bun's hidden staging files without
// deleting named outputs or unrelated hidden configuration.
// → cyberful/script/bun-build-artifacts.ts — implements the cleanup boundary.
// ────────────────────────────────────────────────────────────────────

import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { removeBunBuildArtifacts } from "./bun-build-artifacts"

const directories: string[] = []

afterEach(() => {
  directories.forEach((directory) => fs.rmSync(directory, { force: true, recursive: true }))
  directories.length = 0
})

test("removes only hidden Bun build artifacts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-bun-build-artifacts-"))
  directories.push(directory)

  fs.writeFileSync(path.join(directory, ".18c1f1df5ffebbee-00000006.bun-build"), "temporary runtime")
  fs.writeFileSync(path.join(directory, "release.bun-build"), "named output")
  fs.writeFileSync(path.join(directory, ".env"), "configuration")

  removeBunBuildArtifacts(directory)

  expect(fs.existsSync(path.join(directory, ".18c1f1df5ffebbee-00000006.bun-build"))).toBe(false)
  expect(fs.existsSync(path.join(directory, "release.bun-build"))).toBe(true)
  expect(fs.existsSync(path.join(directory, ".env"))).toBe(true)
})
