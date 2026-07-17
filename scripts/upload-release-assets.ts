#!/usr/bin/env bun
// ── Idempotent GitHub Release Asset Upload ──────────────────────────
// Compares local checksums with existing release assets, rejects divergent
// replacements, and uploads only files that are absent from the tagged release.
// → scripts/write-checksums.ts — produces the checksum manifest uploaded here.
// ────────────────────────────────────────────────────────────────────

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import semver from "semver"

function argument(name: string) {
  const indexes = Bun.argv.flatMap((value, index) => (value === name ? [index] : []))
  if (indexes.length > 1) throw new Error(`${name} may be passed only once`)
  if (indexes.length === 0) return
  const value = Bun.argv[indexes[0] + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

async function sha256(file: string) {
  const hash = crypto.createHash("sha256")
  try {
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  } catch (error) {
    throw new Error(`Cannot hash release asset ${file}`, { cause: error })
  }
  return hash.digest("hex")
}

const tag = argument("--tag")
const directoryArgument = argument("--directory")
const repository = process.env.GITHUB_REPOSITORY?.trim()
if (!tag || !tag.startsWith("v") || !semver.valid(tag.slice(1))) {
  throw new Error("--tag must be a v-prefixed SemVer release tag")
}
if (!directoryArgument) throw new Error("--directory is required")
if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error("GITHUB_REPOSITORY must be an owner/repository pair")
}
const directory = path.resolve(directoryArgument)
if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) throw new Error("--directory is required")

const view = Bun.spawnSync(["gh", "api", `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`], {
  stdout: "pipe",
  stderr: "pipe",
  timeout: 60_000,
  maxBuffer: 2_097_152,
})
if (view.exitCode !== 0) {
  const detail = new TextDecoder().decode(view.stderr).trim().slice(0, 2_000)
  throw new Error(`Cannot inspect GitHub Release ${tag}${detail ? `: ${detail}` : ""}`)
}
let release: unknown
try {
  release = JSON.parse(new TextDecoder().decode(view.stdout))
} catch (error) {
  throw new Error(`GitHub Release ${tag} returned invalid JSON`, { cause: error })
}
if (typeof release !== "object" || release === null || !("assets" in release) || !Array.isArray(release.assets)) {
  throw new Error(`GitHub Release ${tag} returned no asset list`)
}
const rawAssets: unknown[] = release.assets
const assets = rawAssets.filter(
  (asset): asset is { name: string; digest?: string | null } =>
    typeof asset === "object" &&
    asset !== null &&
    "name" in asset &&
    typeof asset.name === "string" &&
    (!("digest" in asset) || asset.digest === null || typeof asset.digest === "string"),
)
if (assets.length !== rawAssets.length) throw new Error(`GitHub Release ${tag} returned an invalid asset record`)
if (new Set(assets.map((asset) => asset.name)).size !== assets.length) {
  throw new Error(`GitHub Release ${tag} returned duplicate asset names`)
}

for (const entry of fs
  .readdirSync(directory, { withFileTypes: true })
  .sort((left, right) => left.name.localeCompare(right.name))) {
  if (!entry.isFile()) continue
  const name = entry.name
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(name)) {
    throw new Error(`Release asset has an unsupported name: ${JSON.stringify(name)}`)
  }
  const file = path.join(directory, name)
  const remote = assets.find((asset) => asset.name === name)
  if (remote) {
    const localDigest = await sha256(file)
    if (remote.digest) {
      if (remote.digest !== `sha256:${localDigest}`) throw new Error(`${name} exists with different integrity`)
      console.log(`Skipping ${name}; GitHub integrity matches`)
      continue
    }

    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-release-asset-"))
    try {
      const download = Bun.spawnSync(
        ["gh", "release", "download", tag, "--repo", repository, "--pattern", name, "--dir", temporary],
        {
          stdout: "inherit",
          stderr: "inherit",
          timeout: 120_000,
        },
      )
      const downloadedFile = path.join(temporary, name)
      if (download.exitCode !== 0 || !fs.statSync(downloadedFile, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`${name} exists and its integrity could not be confirmed`)
      }
      if ((await sha256(downloadedFile)) !== localDigest) throw new Error(`${name} exists with different integrity`)
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
    console.log(`Skipping ${name}; downloaded GitHub asset matches`)
    continue
  }

  const upload = Bun.spawnSync(["gh", "release", "upload", tag, file, "--repo", repository], {
    stdout: "inherit",
    stderr: "inherit",
    timeout: 300_000,
  })
  if (upload.exitCode !== 0) throw new Error(`Cannot upload ${name}`)
}
