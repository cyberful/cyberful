#!/usr/bin/env bun
// ── Release Asset Checksum Manifest ─────────────────────────────────
// Atomically writes a sorted SHA-256 manifest for every regular release asset
// so users and publication automation can verify exact files attached to a tag.
// → scripts/upload-release-assets.ts — uploads the manifest with its assets.
// ────────────────────────────────────────────────────────────────────

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

async function sha256(file: string) {
  const hash = crypto.createHash("sha256")
  try {
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  } catch (error) {
    throw new Error(`Cannot hash release asset ${file}`, { cause: error })
  }
  return hash.digest("hex")
}

export async function writeChecksums(directoryInput: string) {
  const directory = path.resolve(directoryInput)
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("An asset directory is required")
  }
  const names = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "SHA256SUMS" && !entry.name.startsWith(".SHA256SUMS."))
    .map((entry) => entry.name)
    .sort()
  if (names.length === 0) throw new Error("Cannot write a checksum manifest for an empty release")
  const unsupportedName = names.find((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(name))
  if (unsupportedName) {
    throw new Error(`Release asset has an unsupported name: ${JSON.stringify(unsupportedName)}`)
  }

  const entries: string[] = []
  for (const name of names) entries.push(`${await sha256(path.join(directory, name))}  ${name}`)

  // ── Readers Observe A Complete Manifest ──────────────────────────
  // Provenance and upload jobs consume SHA256SUMS immediately after this command.
  // Writing directly to the public name could expose a truncated manifest if the
  // process is interrupted mid-write. A private same-directory file is fully written
  // first, then one rename publishes it atomically on supported release filesystems.
  // Cleanup removes the private file after both success and failure.
  // ────────────────────────────────────────────────────────────────
  const manifest = path.join(directory, "SHA256SUMS")
  const temporary = path.join(directory, `.SHA256SUMS.${crypto.randomUUID()}.tmp`)
  try {
    await Bun.write(temporary, `${entries.join("\n")}\n`)
    fs.renameSync(temporary, manifest)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  return entries.length
}

if (import.meta.main) {
  if (!Bun.argv[2]) throw new Error("An asset directory is required")
  const count = await writeChecksums(Bun.argv[2])
  console.log(`Wrote checksums for ${count} release assets`)
}
