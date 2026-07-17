// ── Release Checksum Manifest Contract ─────────────────────────
// Verifies release users receive deterministic hashes for real asset bytes and
// that invalid or empty release directories cannot produce a misleading manifest.
// → scripts/write-checksums.ts — owns manifest validation and publication.
// ────────────────────────────────────────────────────────────────

import { afterEach, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { writeChecksums } from "../../scripts/write-checksums"

const temporaryRoots: string[] = []

afterEach(() => {
  temporaryRoots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
})

test("writes sorted hashes for the release assets users download", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-checksums-"))
  temporaryRoots.push(root)
  fs.writeFileSync(path.join(root, "zeta.tgz"), "zeta")
  fs.writeFileSync(path.join(root, "alpha.tar.gz"), "alpha")

  expect(await writeChecksums(root)).toBe(2)
  const expected = ["alpha.tar.gz", "zeta.tgz"].map(
    (name) =>
      `${crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(root, name)))
        .digest("hex")}  ${name}`,
  )
  expect(fs.readFileSync(path.join(root, "SHA256SUMS"), "utf8")).toBe(`${expected.join("\n")}\n`)
  expect(fs.readdirSync(root).filter((name) => name.startsWith(".SHA256SUMS."))).toEqual([])
})

test("refuses an empty release instead of publishing an empty manifest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-checksums-empty-"))
  temporaryRoots.push(root)
  await expect(writeChecksums(root)).rejects.toThrow("empty release")
  expect(fs.existsSync(path.join(root, "SHA256SUMS"))).toBe(false)
})
