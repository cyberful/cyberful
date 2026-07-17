#!/usr/bin/env bun
// ── Installed npm Package Smoke Test ────────────────────────────────
// Installs one staged platform tarball with the launcher in an isolated prefix
// and proves the public command reports the release version without a registry.
// → cyberful/script/package-npm.ts — creates the tarballs exercised here.
// ────────────────────────────────────────────────────────────────────

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

const platformPackage = argument("--platform-package")
const metaPackage = argument("--meta-package")
const version = argument("--version")
if (!platformPackage || !metaPackage || !version) {
  throw new Error("--platform-package, --meta-package, and --version are required")
}
if (!semver.valid(version)) throw new Error("--version must be a valid SemVer value")
for (const packageFile of [platformPackage, metaPackage]) {
  if (!fs.statSync(path.resolve(packageFile), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`npm smoke package does not exist: ${packageFile}`)
  }
}

const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-npm-smoke-"))
try {
  // ── The Install Smoke Test Never Consults The Registry ────────────────
  // The current platform tarball is an explicit root dependency of this isolated
  // installation. Optional sibling packages are omitted because they are unavailable
  // until publication; separate manifest tests enforce their complete exact-version
  // map. Offline mode turns any accidental registry dependency into a hard failure.
  // ────────────────────────────────────────────────────────────────
  const install = Bun.spawnSync(
    [
      "npm",
      "install",
      "--global",
      "--prefix",
      prefix,
      "--omit=optional",
      "--offline",
      "--ignore-scripts",
      "--audit=false",
      "--fund=false",
      "--update-notifier=false",
      path.resolve(platformPackage),
      path.resolve(metaPackage),
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 300_000, maxBuffer: 4_194_304 },
  )
  if (install.exitCode !== 0) {
    const detail = new TextDecoder().decode(install.stderr).trim().slice(0, 2_000)
    throw new Error(`The isolated npm installation failed${detail ? `: ${detail}` : ""}`)
  }

  const executable =
    process.platform === "win32" ? path.join(prefix, "cyberful.cmd") : path.join(prefix, "bin/cyberful")
  const smoke = Bun.spawnSync([executable, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
    maxBuffer: 1_048_576,
  })
  if (smoke.exitCode !== 0) {
    const detail = new TextDecoder().decode(smoke.stderr).trim().slice(0, 2_000)
    throw new Error(`The installed npm launcher failed${detail ? `: ${detail}` : ""}`)
  }
  const installedVersion = new TextDecoder().decode(smoke.stdout).trim()
  if (installedVersion !== version) {
    throw new Error(`The npm launcher reported ${installedVersion || "<empty>"}; expected ${version}`)
  }
} finally {
  fs.rmSync(prefix, { recursive: true, force: true })
}

console.log(`npm installation smoke test passed for Cyberful ${version}`)
