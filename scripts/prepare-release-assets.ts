#!/usr/bin/env bun
// ── Cross-Platform Release Archive Assembly ─────────────────────────
// Converts staged npm packages into deterministic user-facing archives while
// preserving platform executables, notices, and baseline x64 variants.
// → cyberful/script/package-npm.ts — supplies the package tarballs consumed here.
// ────────────────────────────────────────────────────────────────────

import fs from "node:fs"
import path from "node:path"
import semver from "semver"

type Platform = {
  platform: "darwin" | "linux" | "windows"
  architecture: "arm64" | "x64"
  baseline: boolean
}

const ARCHIVE_TIME = 499162500
const releaseNotices = [
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ["cyberful/src/tool/assets/fonts/EB_GARAMOND_OFL.txt", "licenses/EB_GARAMOND_OFL.txt"],
  ["cyberful/src/tool/assets/fonts/UBUNTU_FONT_LICENCE.txt", "licenses/UBUNTU_FONT_LICENCE.txt"],
  ["mcps/cyberful-os/wordlists/SECLISTS_LICENSE.txt", "licenses/SECLISTS_LICENSE.txt"],
] as const

function argument(name: string) {
  const indexes = Bun.argv.flatMap((value, index) => (value === name ? [index] : []))
  if (indexes.length > 1) throw new Error(`${name} may be passed only once`)
  if (indexes.length === 0) return
  const value = Bun.argv[indexes[0] + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

function files(directory: string) {
  return Array.from(new Bun.Glob("**/*").scanSync({ cwd: directory, onlyFiles: true })).map((file) =>
    path.join(directory, file),
  )
}

function findSuffix(input: string[], suffix: string) {
  const normalized = suffix.replaceAll("\\", "/")
  const matches = input.filter((file) => file.replaceAll("\\", "/").endsWith(normalized))
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(`Expected one artifact ending in ${suffix}; found ${matches.length}`)
  }
  return matches[0]
}

function copy(source: string, destination: string, executable = false) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
  if (executable && process.platform !== "win32") fs.chmodSync(destination, 0o755)
}

function runArchiveCommand(command: string[], cwd: string | undefined, label: string) {
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync(command, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
      maxBuffer: 2_097_152,
    })
  } catch (error) {
    throw new Error(`Cannot start ${label}`, { cause: error })
  }
  if (result.exitCode === 0) return new TextDecoder().decode(result.stdout)
  const detail = new TextDecoder().decode(result.stderr).trim().slice(0, 2_000)
  throw new Error(`${label} exited with status ${result.exitCode}${detail ? `: ${detail}` : ""}`)
}

function validatePackageArchive(file: string, targetName: string) {
  const members = runArchiveCommand(["tar", "-tzf", file], undefined, `package listing for ${targetName}`)
    .split("\n")
    .filter(Boolean)
  if (members.length === 0) throw new Error(`The npm package for ${targetName} is empty`)
  if (
    members.some((member) => {
      const normalized = member.replaceAll("\\", "/").replace(/\/$/, "")
      return (
        (normalized !== "package" && !normalized.startsWith("package/")) ||
        normalized.split("/").some((segment) => segment === "..") ||
        path.posix.isAbsolute(normalized)
      )
    })
  ) {
    throw new Error(`The npm package for ${targetName} contains an unsafe member path`)
  }
}

function isWithin(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function validateOwnedOutput(repositoryRoot: string, artifacts: string, output: string) {
  if (isWithin(output, repositoryRoot)) {
    throw new Error("Release output cannot be the repository root or one of its ancestors")
  }
  if (isWithin(output, artifacts) || isWithin(artifacts, output)) {
    throw new Error("Release input and output directories must not overlap")
  }
}

function archive(input: {
  repositoryRoot: string
  artifactFiles: string[]
  stagingRoot: string
  output: string
  version: string
  target: Platform
}) {
  const extension = input.target.platform === "windows" ? ".exe" : ""
  const targetName = `cyberful-${input.target.platform}-${input.target.architecture}`
  const rootName = `cyberful-v${input.version}-${input.target.platform}-${input.target.architecture}`
  const root = path.join(input.stagingRoot, rootName)
  const extracted = path.join(input.stagingRoot, `.npm-${targetName}`)
  const packageArtifact = findSuffix(
    input.artifactFiles,
    `cyberful-cli-${input.target.platform}-${input.target.architecture}-${input.version}.tgz`,
  )

  // ── Downloaded Packages Stay Inside Private Staging ───────────────
  // Release assembly can resume from CI artifacts rather than a fresh local pack.
  // Their archive member names are therefore validated before tar receives an
  // extraction destination. Only npm's package/ tree is accepted, preventing an
  // altered artifact from escaping the staging directory through a parent path.
  // Cleanup below removes private extraction data on success and every failure.
  // ────────────────────────────────────────────────────────────────
  validatePackageArchive(packageArtifact, targetName)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(extracted, { recursive: true, force: true })
  fs.mkdirSync(extracted, { recursive: true })
  try {
    runArchiveCommand(
      ["tar", "-xzf", packageArtifact, "-C", extracted],
      undefined,
      `npm package extraction for ${targetName}`,
    )
    copy(
      path.join(extracted, "package/bin", `cyberful${extension}`),
      path.join(root, "bin", `cyberful${extension}`),
      true,
    )
    if (input.target.baseline) {
      copy(
        path.join(extracted, "package/bin", `cyberful-baseline${extension}`),
        path.join(root, "bin", `cyberful-baseline${extension}`),
        true,
      )
    }
    copy(path.join(input.repositoryRoot, "LICENSE"), path.join(root, "LICENSE"))
    releaseNotices.forEach(([source, destination]) =>
      copy(path.join(input.repositoryRoot, source), path.join(root, destination)),
    )
    const pendingTimestamps = [root]
    for (let index = 0; index < pendingTimestamps.length; index++) {
      const file = pendingTimestamps[index]
      fs.utimesSync(file, ARCHIVE_TIME, ARCHIVE_TIME)
      if (!fs.statSync(file).isDirectory()) continue
      pendingTimestamps.push(...fs.readdirSync(file).map((entry) => path.join(file, entry)))
    }

    const filename = `${rootName}.${input.target.platform === "windows" ? "zip" : "tar.gz"}`
    if (input.target.platform === "windows") {
      runArchiveCommand(
        ["zip", "-q", "-X", "-r", path.join(input.output, filename), rootName],
        input.stagingRoot,
        `archive creation for ${filename}`,
      )
      return
    }

    // ── Tar Content And Gzip Identity Are Reproducible Separately ───
    // Some tar implementations stamp their integrated gzip stream with the
    // current second even after every archived member has a normalized time.
    // The tar payload is therefore created first with stable member metadata,
    // then gzip -n removes the compressor timestamp and original filename.
    // A temporary pair keeps partial output private until both stages succeed.
    // ────────────────────────────────────────────────────────────────
    const temporaryTar = path.join(input.stagingRoot, `.${rootName}.tar`)
    const compressedTar = `${temporaryTar}.gz`
    try {
      runArchiveCommand(
        process.platform === "linux"
          ? [
              "tar",
              "--sort=name",
              "--mtime=@0",
              "--owner=0",
              "--group=0",
              "--numeric-owner",
              "-cf",
              temporaryTar,
              rootName,
            ]
          : ["tar", "-cf", temporaryTar, rootName],
        input.stagingRoot,
        `tar creation for ${filename}`,
      )
      runArchiveCommand(["gzip", "-n", "-f", temporaryTar], undefined, `gzip compression for ${filename}`)
      fs.renameSync(compressedTar, path.join(input.output, filename))
    } finally {
      fs.rmSync(temporaryTar, { force: true })
      fs.rmSync(compressedTar, { force: true })
    }
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true })
  }
}

export function prepareReleaseAssets(input: {
  repositoryRoot: string
  artifacts: string
  output: string
  version: string
}) {
  const repositoryRoot = path.resolve(input.repositoryRoot)
  const artifacts = path.resolve(input.artifacts)
  const output = path.resolve(input.output)
  if (!fs.statSync(artifacts, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Release artifacts must be an existing directory")
  }
  if (!semver.valid(input.version)) throw new Error(`Release version must be valid SemVer: ${input.version}`)
  validateOwnedOutput(repositoryRoot, artifacts, output)

  fs.rmSync(output, { recursive: true, force: true })
  fs.mkdirSync(output, { recursive: true })
  const artifactFiles = files(artifacts)
  artifactFiles
    .filter((file) => file.endsWith(".tgz"))
    .forEach((file) => copy(file, path.join(output, path.basename(file))))

  const stagingRoot = path.join(output, ".stage")
  fs.mkdirSync(stagingRoot, { recursive: true })
  try {
    ;(
      [
        { platform: "linux", architecture: "x64", baseline: true },
        { platform: "darwin", architecture: "arm64", baseline: false },
        { platform: "darwin", architecture: "x64", baseline: true },
        { platform: "windows", architecture: "x64", baseline: true },
      ] satisfies Platform[]
    ).forEach((target) =>
      archive({
        repositoryRoot,
        artifactFiles,
        stagingRoot,
        output,
        version: input.version,
        target,
      }),
    )
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const input = argument("--input")
  const output = argument("--output")
  const version = argument("--version")
  if (!input || !fs.statSync(input, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("--input must be a directory")
  }
  if (!output) throw new Error("--output is required")
  if (!version) throw new Error("--version is required")
  prepareReleaseAssets({
    repositoryRoot: path.resolve(import.meta.dir, ".."),
    artifacts: path.resolve(input),
    output: path.resolve(output),
    version,
  })
  console.log(`Prepared release assets in ${path.resolve(output)}`)
}
