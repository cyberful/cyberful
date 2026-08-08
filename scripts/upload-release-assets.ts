#!/usr/bin/env bun
// ── Idempotent GitHub Release Asset Upload ──────────────────────────
// Resolves authenticated draft or public releases by ID, rejects divergent
// replacements, and uploads only files absent from the exact release record.
// → scripts/write-checksums.ts — produces the checksum manifest uploaded here.
// @docs/development/release.md
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

function parseJson(source: string, label: string) {
  try {
    return JSON.parse(source) as unknown
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error })
  }
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

type GitHubAsset = { id: number; name: string; digest?: string | null }
type GitHubRelease = { id: number; uploadUrl: string; assets: GitHubAsset[] }

function validateRelease(repository: string, tag: string, value: unknown): GitHubRelease {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) <= 0 ||
    !("tag_name" in value) ||
    value.tag_name !== tag ||
    !("upload_url" in value) ||
    typeof value.upload_url !== "string" ||
    !("assets" in value) ||
    !Array.isArray(value.assets)
  ) {
    throw new Error(`GitHub Release ${tag} returned an invalid release record`)
  }
  const uploadUrl = value.upload_url.replace(/\{\?name,label\}$/, "")
  if (uploadUrl !== `https://uploads.github.com/repos/${repository}/releases/${value.id}/assets`) {
    throw new Error(`GitHub Release ${tag} returned an invalid upload URL`)
  }
  const assets = value.assets.filter(
    (asset): asset is GitHubAsset =>
      typeof asset === "object" &&
      asset !== null &&
      "id" in asset &&
      Number.isSafeInteger(asset.id) &&
      Number(asset.id) > 0 &&
      "name" in asset &&
      typeof asset.name === "string" &&
      (!("digest" in asset) || asset.digest === null || typeof asset.digest === "string"),
  )
  if (assets.length !== value.assets.length) throw new Error(`GitHub Release ${tag} returned an invalid asset record`)
  if (new Set(assets.map((asset) => asset.name)).size !== assets.length) {
    throw new Error(`GitHub Release ${tag} returned duplicate asset names`)
  }
  return { id: Number(value.id), uploadUrl, assets }
}

export function githubReleaseById(repository: string, tag: string, releaseId: number, ghExecutable = "gh") {
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0) throw new Error("GitHub Release ID must be a positive integer")
  const lookup = Bun.spawnSync([ghExecutable, "api", `repos/${repository}/releases/${releaseId}`], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    maxBuffer: 16_777_216,
  })
  if (lookup.exitCode !== 0) {
    const detail = new TextDecoder().decode(lookup.stderr).trim().slice(0, 2_000)
    throw new Error(`Cannot inspect GitHub Release ${tag}${detail ? `: ${detail}` : ""}`)
  }
  const release = validateRelease(
    repository,
    tag,
    parseJson(new TextDecoder().decode(lookup.stdout), `GitHub Release ${tag}`),
  )
  if (release.id !== releaseId) throw new Error(`GitHub Release ${tag} returned the wrong release ID`)
  return release
}

// ── Draft Releases Require Authenticated List Resolution ───────────
// GitHub's release-by-tag endpoint exposes public releases but returns 404 for
// an authenticated draft, whose browser URL uses a temporary `untagged-*` name.
// The authenticated release list includes drafts for callers with push access,
// so exact tag matching there yields the stable numeric ID used by every asset
// operation. Duplicate matches fail closed rather than selecting arbitrary state.
// ────────────────────────────────────────────────────────────────────
export function githubReleaseByTag(repository: string, tag: string, ghExecutable = "gh") {
  const listing = Bun.spawnSync(
    [ghExecutable, "api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      maxBuffer: 16_777_216,
    },
  )
  if (listing.exitCode !== 0) {
    const detail = new TextDecoder().decode(listing.stderr).trim().slice(0, 2_000)
    throw new Error(`Cannot inspect GitHub Release ${tag}${detail ? `: ${detail}` : ""}`)
  }
  const pages = parseJson(new TextDecoder().decode(listing.stdout), `GitHub Release list for ${tag}`)
  if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) {
    throw new Error(`GitHub Release list for ${tag} returned an invalid page set`)
  }
  const matches = pages
    .flat()
    .filter(
      (release): release is Record<string, unknown> =>
        typeof release === "object" && release !== null && release.tag_name === tag,
    )
  if (matches.length === 0) return
  if (matches.length > 1) throw new Error(`GitHub returned multiple releases for ${tag}`)
  return validateRelease(repository, tag, matches[0])
}

if (import.meta.main) {
  const tag = argument("--tag")
  const releaseIdArgument = argument("--release-id")
  const directoryArgument = argument("--directory")
  const repository = process.env.GITHUB_REPOSITORY?.trim()
  if (!tag || !tag.startsWith("v") || !semver.valid(tag.slice(1))) {
    throw new Error("--tag must be a v-prefixed SemVer release tag")
  }
  if (!directoryArgument) throw new Error("--directory is required")
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be an owner/repository pair")
  }
  const releaseId = releaseIdArgument === undefined ? undefined : Number(releaseIdArgument)
  if (releaseId !== undefined && (!Number.isSafeInteger(releaseId) || releaseId <= 0)) {
    throw new Error("--release-id must be a positive integer")
  }
  const directory = path.resolve(directoryArgument)
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) throw new Error("--directory is required")
  const release = releaseId === undefined
    ? githubReleaseByTag(repository, tag)
    : githubReleaseById(repository, tag, releaseId)
  if (!release) throw new Error(`GitHub Release ${tag} does not exist`)

  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) continue
    const name = entry.name
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(name)) {
      throw new Error(`Release asset has an unsupported name: ${JSON.stringify(name)}`)
    }
    const file = path.join(directory, name)
    const localDigest = await sha256(file)
    const remote = release.assets.find((asset) => asset.name === name)
    if (remote) {
      if (remote.digest) {
        if (remote.digest !== `sha256:${localDigest}`) throw new Error(`${name} exists with different integrity`)
        console.log(`Skipping ${name}; GitHub integrity matches`)
        continue
      }

      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-release-asset-"))
      try {
        const downloadedFile = path.join(temporary, name)
        const download = Bun.spawnSync(
          ["gh", "api", "-H", "Accept: application/octet-stream", `repos/${repository}/releases/assets/${remote.id}`],
          {
            stdout: Bun.file(downloadedFile),
            stderr: "pipe",
            timeout: 120_000,
          },
        )
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

    const upload = Bun.spawnSync(
      [
        "gh",
        "api",
        "--method",
        "POST",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "Content-Type: application/octet-stream",
        "--input",
        file,
        `${release.uploadUrl}?name=${encodeURIComponent(name)}`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 300_000,
        maxBuffer: 2_097_152,
      },
    )
    if (upload.exitCode !== 0) {
      const detail = new TextDecoder().decode(upload.stderr).trim().slice(0, 2_000)
      throw new Error(`Cannot upload ${name}${detail ? `: ${detail}` : ""}`)
    }
    const uploaded = parseJson(new TextDecoder().decode(upload.stdout), `GitHub upload for ${name}`)
    if (
      typeof uploaded !== "object" ||
      uploaded === null ||
      !("name" in uploaded) ||
      uploaded.name !== name ||
      !("digest" in uploaded) ||
      uploaded.digest !== `sha256:${localDigest}`
    ) {
      throw new Error(`GitHub did not confirm the integrity of uploaded asset ${name}`)
    }
    console.log(`Uploaded ${name}; GitHub integrity matches`)
  }
}
