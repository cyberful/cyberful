// ── Release Build Identity ──────────────────────────────────────────
// Validates the configured Bun runtime and exposes one canonical release
// version and channel to build, packaging, and publication scripts.
// → cyberful/script/build.ts — embeds this identity into standalone binaries.
// ────────────────────────────────────────────────────────────────────

import semver from "semver"
import path from "node:path"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJsonObject(source: string, label: string) {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`${label} must contain valid JSON`, { cause: error })
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must contain a JSON object`)
  }
  return value
}

const rootPackage = parseJsonObject(
  await Bun.file(path.resolve(import.meta.dir, "../package.json")).text(),
  "package.json",
)
const packageInfo = parseJsonObject(
  await Bun.file(path.resolve(import.meta.dir, "../cyberful/package.json")).text(),
  "cyberful/package.json",
)
const expectedBunVersion =
  typeof rootPackage.packageManager === "string" ? rootPackage.packageManager.split("@")[1] : undefined

if (!expectedBunVersion || !semver.valid(expectedBunVersion)) {
  throw new Error("packageManager must declare bun with an exact SemVer version")
}

const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const packageVersion = typeof packageInfo.version === "string" ? packageInfo.version : undefined
const VERSION = process.env.CYBERFUL_VERSION?.trim() || packageVersion
if (!VERSION) throw new Error("version field not found in cyberful/package.json")
const CHANNEL = process.env.CYBERFUL_CHANNEL?.trim() || (semver.prerelease(VERSION) ? "development" : "latest")

if (!semver.valid(VERSION)) throw new Error(`Invalid CYBERFUL_VERSION: ${VERSION}`)
if (CHANNEL !== "latest" && CHANNEL !== "development") {
  throw new Error(`CYBERFUL_CHANNEL must be latest or development: ${CHANNEL}`)
}

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return CHANNEL !== "latest"
  },
}
