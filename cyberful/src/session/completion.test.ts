// ── Completion Artifact Boundary Tests ─────────────────────────────────────
// Verifies that real workarea files survive while traversal and symlink escapes are rejected.
// → cyberful/src/session/completion.ts — validates the tested completion artifacts.
// ───────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { SessionCompletion } from "./completion"

describe("completion artifacts", () => {
  test("accepts regular workarea files and rejects traversal and symlinks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-completion-"))
    const outside = await mkdtemp(path.join(os.tmpdir(), "cyberful-outside-"))
    try {
      await mkdir(path.join(root, "reports"))
      await Bun.write(path.join(root, "reports", "security-report.pdf"), "%PDF-1.7")
      await Bun.write(path.join(outside, "secret.txt"), "secret")
      await symlink(path.join(outside, "secret.txt"), path.join(root, "linked.txt"))
      expect(
        await SessionCompletion.validateArtifacts(root, [
          { label: `Report${"!".repeat(100)}`, path: "reports/security-report.pdf", primary: true },
          { label: "Outside", path: "../secret.txt" },
          { label: "Linked", path: "linked.txt" },
        ]),
      ).toEqual([
        {
          label: `Report${"!".repeat(74)}`,
          path: "reports/security-report.pdf",
          mime: "application/pdf",
          primary: true,
        },
      ])
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
    }
  })
})
