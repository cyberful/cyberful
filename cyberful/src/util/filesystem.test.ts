// ── Cross-Platform Path Containment Tests ────────────────────────
// Verifies that containment distinguishes traversal from valid child names,
// including directories whose names begin with two dots.
// → cyberful/src/util/filesystem.ts — owns the shared path boundary.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import path from "node:path"
import { contains } from "./filesystem"

test("path containment accepts self and children but rejects traversal", () => {
  const root = path.resolve("containment-root")

  expect(contains(root, root)).toBe(true)
  expect(contains(root, path.join(root, "child"))).toBe(true)
  expect(contains(root, path.join(root, "..child"))).toBe(true)
  expect(contains(root, path.resolve(root, "..", "sibling"))).toBe(false)
})
