#!/usr/bin/env bun
// ── npm Package Assembly ────────────────────────────────────────────
// Stages platform binaries and the portable launcher into their public npm
// layouts, writes exact-version manifests, and packs one audited artifact.
// → cyberful/bin/resolve.cjs — resolves optional platform packages at runtime.
// ────────────────────────────────────────────────────────────────────

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import semver from "semver"
import { extract, list } from "tar"

export type NpmPlatform = "darwin" | "linux" | "windows"
export type NpmArchitecture = "arm64" | "x64"

const repository = { type: "git", url: "git+https://github.com/cyberful/cyberful.git" }
const homepage = "https://github.com/cyberful/cyberful#readme"
const bugs = { url: "https://github.com/cyberful/cyberful/issues" }
const publicPackages = [
  "@cyberful-org/cyberful-darwin-arm64",
  "@cyberful-org/cyberful-darwin-x64",
  "@cyberful-org/cyberful-linux-x64",
  "@cyberful-org/cyberful-windows-x64",
]
const publicTargets = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "windows-x64"])
const npmPublishTarballLimitBytes = 190_000_000
const maximumUnpackedTarBytes = 1_500_000_000
const releaseNotices = [
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ["cyberful/src/tool/assets/fonts/EB_GARAMOND_OFL.txt", "licenses/EB_GARAMOND_OFL.txt"],
  ["cyberful/src/tool/assets/fonts/UBUNTU_FONT_LICENCE.txt", "licenses/UBUNTU_FONT_LICENCE.txt"],
  ["mcps/cyberful-os/wordlists/SECLISTS_LICENSE.txt", "licenses/SECLISTS_LICENSE.txt"],
] as const

function isNpmPlatform(value: string | undefined): value is NpmPlatform {
  return value === "darwin" || value === "linux" || value === "windows"
}

function isNpmArchitecture(value: string | undefined): value is NpmArchitecture {
  return value === "arm64" || value === "x64"
}

export function platformPackageName(platform: NpmPlatform, architecture: NpmArchitecture) {
  return `@cyberful-org/cyberful-${platform}-${architecture}`
}

export function platformManifest(platform: NpmPlatform, architecture: NpmArchitecture, version: string) {
  return {
    name: platformPackageName(platform, architecture),
    version,
    description: `Cyberful standalone binary for ${platform} ${architecture}`,
    license: "AGPL-3.0-only",
    repository,
    homepage,
    bugs,
    preferUnplugged: true,
    os: [platform === "windows" ? "win32" : platform],
    cpu: [architecture],
    ...(platform === "linux" ? { libc: ["glibc"] } : {}),
    files: ["bin", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "licenses"],
    publishConfig: { access: "public" },
  }
}

export function metaManifest(version: string) {
  return {
    name: "cyberful",
    version,
    description: "AI-powered application-security workbench for authorized security workflows",
    license: "AGPL-3.0-only",
    repository,
    homepage,
    bugs,
    engines: { node: ">=18" },
    bin: { cyberful: "bin/cyberful" },
    files: ["bin", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "licenses"],
    optionalDependencies: Object.fromEntries(publicPackages.map((name) => [name, version])),
    publishConfig: { access: "public" },
  }
}

function writeManifest(
  directory: string,
  manifest: ReturnType<typeof platformManifest> | ReturnType<typeof metaManifest>,
) {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

function copyFile(source: string, destination: string, executable = false) {
  if (!fs.existsSync(source)) throw new Error(`Required package input is missing: ${source}`)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
  if (executable && process.platform !== "win32") fs.chmodSync(destination, 0o755)
}

function copyReleaseNotices(repositoryRoot: string, packageRoot: string) {
  releaseNotices.forEach(([source, destination]) =>
    copyFile(path.join(repositoryRoot, source), path.join(packageRoot, destination)),
  )
}

function validatePackageRoot(repositoryRoot: string, packageRoot: string) {
  const relative = path.relative(packageRoot, repositoryRoot)
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("Package staging cannot replace the repository root or one of its ancestors")
  }
}

export function stagePlatformPackage(input: {
  repositoryRoot: string
  packageRoot: string
  platform: NpmPlatform
  architecture: NpmArchitecture
  version: string
}) {
  validatePackageRoot(input.repositoryRoot, input.packageRoot)
  fs.rmSync(input.packageRoot, { recursive: true, force: true })
  writeManifest(input.packageRoot, platformManifest(input.platform, input.architecture, input.version))
  copyFile(path.join(input.repositoryRoot, "LICENSE"), path.join(input.packageRoot, "LICENSE"))
  copyFile(path.join(input.repositoryRoot, "README.md"), path.join(input.packageRoot, "README.md"))
  copyReleaseNotices(input.repositoryRoot, input.packageRoot)

  const extension = input.platform === "windows" ? ".exe" : ""
  const target = `cyberful-${input.platform}-${input.architecture}`
  copyFile(
    path.join(input.repositoryRoot, "cyberful/dist", target, "bin", `cyberful${extension}`),
    path.join(input.packageRoot, "bin", `cyberful${extension}`),
    true,
  )
  if (input.architecture === "x64") {
    copyFile(
      path.join(input.repositoryRoot, "cyberful/dist", `${target}-baseline`, "bin", `cyberful${extension}`),
      path.join(input.packageRoot, "bin", `cyberful-baseline${extension}`),
      true,
    )
  }
  return input.packageRoot
}

export function stageMetaPackage(input: { repositoryRoot: string; packageRoot: string; version: string }) {
  validatePackageRoot(input.repositoryRoot, input.packageRoot)
  fs.rmSync(input.packageRoot, { recursive: true, force: true })
  writeManifest(input.packageRoot, metaManifest(input.version))
  copyFile(path.join(input.repositoryRoot, "LICENSE"), path.join(input.packageRoot, "LICENSE"))
  copyFile(path.join(input.repositoryRoot, "README.md"), path.join(input.packageRoot, "README.md"))
  copyReleaseNotices(input.repositoryRoot, input.packageRoot)
  copyFile(path.join(input.repositoryRoot, "cyberful/bin/cyberful"), path.join(input.packageRoot, "bin/cyberful"), true)
  copyFile(path.join(input.repositoryRoot, "cyberful/bin/resolve.cjs"), path.join(input.packageRoot, "bin/resolve.cjs"))
  return input.packageRoot
}

function argument(name: string) {
  const indexes = Bun.argv.flatMap((value, index) => (value === name ? [index] : []))
  if (indexes.length > 1) throw new Error(`${name} may be passed only once`)
  if (indexes.length === 0) return
  const value = Bun.argv[indexes[0] + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

export function packNpmPackage(directory: string, destination: string) {
  fs.mkdirSync(destination, { recursive: true })
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-npm-cache-"))
  try {
    let result: ReturnType<typeof Bun.spawnSync>
    try {
      result = Bun.spawnSync(
        [
          "npm",
          "pack",
          "--json",
          "--ignore-scripts",
          "--offline",
          "--cache",
          cacheRoot,
          "--pack-destination",
          destination,
        ],
        {
          cwd: directory,
          stdout: "pipe",
          stderr: "pipe",
          timeout: 120_000,
          maxBuffer: 2_097_152,
        },
      )
    } catch (error) {
      throw new Error(`Cannot start npm pack for ${directory}`, { cause: error })
    }
    if (result.exitCode !== 0) {
      const detail = new TextDecoder().decode(result.stderr).trim().slice(0, 2_000)
      throw new Error(`npm pack failed for ${directory}${detail ? `: ${detail}` : ""}`)
    }
    let output: unknown
    try {
      output = JSON.parse(new TextDecoder().decode(result.stdout))
    } catch (error) {
      throw new Error(`npm pack returned invalid JSON for ${directory}`, { cause: error })
    }
    if (!Array.isArray(output)) throw new Error(`npm pack returned a non-array result for ${directory}`)
    const entries: unknown[] = output
    const entry = entries[0]
    if (
      entries.length !== 1 ||
      typeof entry !== "object" ||
      entry === null ||
      !("filename" in entry) ||
      typeof entry.filename !== "string" ||
      !entry.filename
    ) {
      throw new Error(`npm pack returned an invalid artifact record for ${directory}`)
    }
    return path.join(destination, entry.filename)
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true })
  }
}

function parsePackageManifest(packageRoot: string) {
  const manifestFile = path.join(packageRoot, "package.json")
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(manifestFile, "utf8"))
  } catch (error) {
    throw new Error(`Cannot read npm package manifest ${manifestFile}`, { cause: error })
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !semver.valid(value.version)
  ) {
    throw new Error(`npm package manifest must contain a package name and valid version: ${manifestFile}`)
  }
  return { name: value.name, version: value.version }
}

async function validateNpmArchive(file: string) {
  let unpackedBytes = 0
  let entries = 0
  try {
    await list({
      file,
      strict: true,
      onReadEntry(entry) {
        const normalized = entry.path.replaceAll("\\", "/").replace(/\/$/, "")
        if (
          (normalized !== "package" && !normalized.startsWith("package/")) ||
          normalized.split("/").some((segment) => segment === "..") ||
          path.posix.isAbsolute(normalized) ||
          (entry.type !== "File" && entry.type !== "Directory")
        ) {
          throw new Error(`npm package contains an unsafe archive entry: ${entry.path}`)
        }
        unpackedBytes += entry.size
        entries += 1
        if (unpackedBytes > maximumUnpackedTarBytes) {
          throw new Error(`npm package expands beyond ${maximumUnpackedTarBytes} bytes: ${file}`)
        }
      },
    })
  } catch (error) {
    throw new Error(`Cannot validate npm package ${file}`, { cause: error })
  }
  if (entries === 0) throw new Error(`npm package is empty: ${file}`)
}

// ── Universal x64 Packages Store One Binary Body ───────────────────
// npm publishes a tarball inside a larger registry request, so two independent
// standalone executables can exceed the request limit even when the compressed
// archive itself appears smaller than that limit. Linux and Windows npm packages
// therefore retain both launcher-visible filenames as hard links to the baseline
// executable, which runs on AVX2 and older x64 hosts while storing one byte body.
// Standalone release archives are assembled before this transformation and keep
// their distinct optimized and baseline binaries.
// ────────────────────────────────────────────────────────────────────
export async function repackUniversalX64Package(file: string, options: { uploadLimitBytes?: number } = {}) {
  const packageFile = path.resolve(file)
  const source = fs.statSync(packageFile, { throwIfNoEntry: false })
  if (!source?.isFile() || !packageFile.endsWith(".tgz")) throw new Error("An npm .tgz package is required")
  const uploadLimitBytes = options.uploadLimitBytes ?? npmPublishTarballLimitBytes
  if (!Number.isSafeInteger(uploadLimitBytes) || uploadLimitBytes <= 0) {
    throw new Error("The npm upload limit must be a positive integer")
  }
  await validateNpmArchive(packageFile)

  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-npm-universal-"))
  const replacementRoot = fs.mkdtempSync(path.join(path.dirname(packageFile), ".cyberful-npm-repack-"))
  try {
    await extract({ file: packageFile, cwd: stagingRoot, strict: true, preservePaths: false, unlink: true })
    const packageRoot = path.join(stagingRoot, "package")
    const manifest = parsePackageManifest(packageRoot)
    const extension = manifest.name === "@cyberful-org/cyberful-windows-x64" ? ".exe" : ""
    if (
      manifest.name !== "@cyberful-org/cyberful-linux-x64" &&
      manifest.name !== "@cyberful-org/cyberful-windows-x64"
    ) {
      throw new Error(`Only Linux and Windows x64 npm packages can be repacked: ${manifest.name}`)
    }

    const optimizedBinary = path.join(packageRoot, "bin", `cyberful${extension}`)
    const baselineBinary = path.join(packageRoot, "bin", `cyberful-baseline${extension}`)
    for (const binary of [optimizedBinary, baselineBinary]) {
      if (!fs.statSync(binary, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Required x64 npm binary is missing: ${binary}`)
      }
    }
    fs.rmSync(optimizedBinary)
    fs.linkSync(baselineBinary, optimizedBinary)

    const repacked = packNpmPackage(packageRoot, replacementRoot)
    if (path.basename(repacked) !== path.basename(packageFile)) {
      throw new Error(`Repacked npm filename changed from ${path.basename(packageFile)} to ${path.basename(repacked)}`)
    }
    const bytes = fs.statSync(repacked).size
    if (bytes >= uploadLimitBytes) {
      throw new Error(`npm package remains above the ${uploadLimitBytes}-byte publish limit: ${packageFile}`)
    }

    const verificationRoot = path.join(stagingRoot, "verification")
    fs.mkdirSync(verificationRoot)
    await extract({ file: repacked, cwd: verificationRoot, strict: true, preservePaths: false, unlink: true })
    const verifiedBin = path.join(verificationRoot, "package", "bin")
    const verifiedOptimized = path.join(verifiedBin, `cyberful${extension}`)
    const verifiedBaseline = path.join(verifiedBin, `cyberful-baseline${extension}`)
    const optimizedStat = fs.statSync(verifiedOptimized)
    const baselineStat = fs.statSync(verifiedBaseline)
    if (
      optimizedStat.ino !== baselineStat.ino ||
      !fs.readFileSync(verifiedOptimized).equals(fs.readFileSync(verifiedBaseline))
    ) {
      throw new Error(`Repacked npm package did not preserve one universal hard-linked binary: ${packageFile}`)
    }

    fs.renameSync(repacked, packageFile)
    return { afterBytes: bytes, beforeBytes: source.size, packageName: manifest.name, version: manifest.version }
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true })
    fs.rmSync(replacementRoot, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const repositoryRoot = path.resolve(import.meta.dir, "../..")
  const version = argument("--version") || process.env.CYBERFUL_VERSION?.trim() || ""
  if (!semver.valid(version)) throw new Error(`--version must be a valid SemVer value: ${version || "<empty>"}`)
  const output = path.resolve(argument("--output") || path.join(repositoryRoot, "cyberful/dist/npm"))
  const packageRoot = path.join(output, "stage")
  const platform = argument("--platform")
  const architecture = argument("--arch")
  let staged: string
  if (Bun.argv.includes("--meta")) {
    staged = stageMetaPackage({ repositoryRoot, packageRoot, version })
  } else {
    if (!isNpmPlatform(platform)) {
      throw new Error(`--platform must be darwin, linux, or windows: ${platform || "<empty>"}`)
    }
    if (!isNpmArchitecture(architecture)) {
      throw new Error(`--arch must be arm64 or x64: ${architecture || "<empty>"}`)
    }
    if (!publicTargets.has(`${platform}-${architecture}`)) {
      throw new Error(`Cyberful does not publish @cyberful-org/cyberful-${platform}-${architecture}`)
    }
    staged = stagePlatformPackage({
      repositoryRoot,
      packageRoot,
      version,
      platform,
      architecture,
    })
  }
  const artifact = packNpmPackage(staged, path.join(output, "packages"))
  console.log(JSON.stringify({ artifact, staged }, null, 2))
}
