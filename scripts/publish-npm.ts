#!/usr/bin/env bun
// ── Idempotent npm Publication ──────────────────────────────────────
// Publishes platform packages before the launcher and resumes partial releases
// only when remote integrity exactly matches the corresponding local tarball.
// → cyberful/script/package-npm.ts — creates the artifacts published here.
// ────────────────────────────────────────────────────────────────────

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import semver from "semver"

const expectedPackages = [
  "@cyberful/cli-darwin-arm64",
  "@cyberful/cli-darwin-x64",
  "@cyberful/cli-linux-x64",
  "@cyberful/cli-windows-x64",
  "@cyberful/cli",
]

export async function npmIntegrity(file: string) {
  const hash = crypto.createHash("sha512")
  try {
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  } catch (error) {
    throw new Error(`Cannot hash npm package ${file}`, { cause: error })
  }
  return `sha512-${hash.digest("base64")}`
}

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

function manifest(file: string) {
  const result = Bun.spawnSync(["tar", "-xOf", file, "package/package.json"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
    maxBuffer: 1_048_576,
  })
  if (result.exitCode !== 0) throw new Error(`Cannot read package.json from ${file}`)
  const value = parseJson(new TextDecoder().decode(result.stdout), `package manifest in ${file}`)
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error(`package.json in ${file} must contain string name and version fields`)
  }
  return { name: value.name, version: value.version }
}

// ── Registry Failure Never Authorizes Publication ────────────────────
// Resuming a release must distinguish a package that does not exist from a registry
// query that could not complete. Only npm's explicit E404 outcome authorizes a new
// publish; authentication, transport, timeout, malformed JSON, and invalid integrity
// responses stop the release. This prevents an outage from becoming an overwrite
// attempt and preserves the original diagnostic in a bounded error message.
// ────────────────────────────────────────────────────────────────
export function publishedIntegrity(name: string, version: string, npmExecutable = "npm") {
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync([npmExecutable, "view", `${name}@${version}`, "dist.integrity", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      maxBuffer: 1_048_576,
    })
  } catch (error) {
    throw new Error(`Cannot start npm while checking ${name}@${version}`, { cause: error })
  }
  const stderr = new TextDecoder().decode(result.stderr).trim().slice(0, 2_000)
  if (result.exitCode !== 0) {
    if (/(?:^|\W)E404(?:\W|$)/.test(stderr)) return
    throw new Error(
      `npm view failed for ${name}@${version} with status ${result.exitCode}${stderr ? `: ${stderr}` : ""}`,
    )
  }
  const value = parseJson(new TextDecoder().decode(result.stdout), `npm view for ${name}@${version}`)
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`npm view returned an invalid integrity for ${name}@${version}`)
  }
  return value
}

if (import.meta.main) {
  const directoryArgument = argument("--directory")
  const version = argument("--version")
  if (!directoryArgument) throw new Error("--directory is required")
  const directory = path.resolve(directoryArgument)
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) throw new Error("--directory is required")
  if (!version || !semver.valid(version) || semver.prerelease(version)) {
    throw new Error("--version must be a stable SemVer value")
  }

  const packages = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
    .map((entry) => ({
      file: path.join(directory, entry.name),
      manifest: manifest(path.join(directory, entry.name)),
    }))
  const byName = new Map(packages.map((entry) => [entry.manifest.name, entry]))
  if (byName.size !== packages.length) throw new Error("The npm release directory contains duplicate package names")
  const unexpected = [...byName.keys()].filter((name) => !expectedPackages.includes(name))
  if (unexpected.length) throw new Error(`Unexpected npm release packages: ${unexpected.join(", ")}`)
  const missing = expectedPackages.filter((name) => !byName.has(name))
  if (missing.length) throw new Error(`Missing npm release packages: ${missing.join(", ")}`)

  for (const name of expectedPackages) {
    const entry = byName.get(name)
    if (!entry) throw new Error(`Missing npm release package: ${name}`)
    if (entry.manifest.version !== version) {
      throw new Error(`${name} contains version ${entry.manifest.version}; expected ${version}`)
    }
    const remote = publishedIntegrity(name, version)
    const local = await npmIntegrity(entry.file)
    if (remote && remote !== local) throw new Error(`${name}@${version} already exists with different integrity`)
    if (remote === local) {
      console.log(`Skipping ${name}@${version}; npm integrity matches`)
      continue
    }

    const publish = Bun.spawnSync(
      ["npm", "publish", entry.file, "--access", "public", "--tag", "latest", "--provenance", "--ignore-scripts"],
      { stdout: "inherit", stderr: "inherit", timeout: 300_000 },
    )
    if (publish.exitCode !== 0) throw new Error(`npm publish failed for ${name}@${version}`)
  }
}
