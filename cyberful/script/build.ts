#!/usr/bin/env bun
// ── Standalone Binary Build Pipeline ────────────────────────────────
// Compiles each supported Cyberful target, embeds its host-side first-party
// assets and runtime-image digest, then applies compatibility launch smoke tests.
// → cyberful/src/bootstrap-config.ts — materializes the embedded host launchers.
// → cyberful/src/runtime-version.ts — supplies the embedded Pi attestation contract.
// → scripts/release.ts — supplies the immutable version and channel identity.
// ────────────────────────────────────────────────────────────────────

import fs from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { Script } from "../../scripts/release"
import pkg from "../package.json"
import * as Builtin from "../src/builtin"
import { removeBunBuildArtifacts } from "./bun-build-artifacts"
import { embeddedRuntimeVersions, RUNTIME_VERSION_ARGV } from "../src/runtime-version"
import {
  buildAttackSnapshot,
  embeddedAttackSnapshot,
  validateAttackRoutingIdentifiers,
} from "../src/mitre-attack/builder"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

function releaseBuildID() {
  const configured = process.env.CYBERFUL_BUILD_ID?.trim()
  if (!configured) return `${Script.version}-${crypto.randomUUID()}`
  if (configured.length > 256 || /[\u0000-\u001f\u007f]/.test(configured)) {
    throw new Error("CYBERFUL_BUILD_ID must be at most 256 printable characters")
  }
  return configured
}

async function runBuildCommand(argv: string[]) {
  const child = Bun.spawn(argv, {
    cwd: dir,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    timeout: 600_000,
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} exited with status ${exitCode}`)
}

function decodeRuntimeVersions(raw: string) {
  const parsed: unknown = JSON.parse(raw)
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("piAgentCore" in parsed) ||
    typeof parsed.piAgentCore !== "string" ||
    !("piAi" in parsed) ||
    typeof parsed.piAi !== "string"
  )
    throw new Error("Cyberful runtime-version probe returned an invalid payload")
  return { piAgentCore: parsed.piAgentCore, piAi: parsed.piAi }
}

function installedPackageVersion(packageName: string) {
  const manifestPath = path.join(dir, "node_modules", packageName, "package.json")
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || typeof parsed.version !== "string") {
    throw new Error(`Invalid installed package manifest: ${manifestPath}`)
  }
  return parsed.version
}

// ── Interrupted Builds Cannot Own The Next Invocation ────────────
// Bun stages hidden runtime artifacts beside this script while compiling a binary.
// A terminated build can leave them behind, and a later build may mistake them for
// current output. Startup removes predecessor debris; the process exit hook repeats
// the idempotent cleanup after both successful and failed invocations.
// → cyberful/script/bun-build-artifacts.ts — recognizes the owned staging names.
// ────────────────────────────────────────────────────────────────
removeBunBuildArtifacts(dir)
process.on("exit", () => removeBunBuildArtifacts(dir))

const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const inlineTargetArgument = process.argv.find((value) => value.startsWith("--target="))
const targetIndex = process.argv.indexOf("--target")
if (inlineTargetArgument && targetIndex !== -1) throw new Error("Pass --target only once")
const targetArgument =
  inlineTargetArgument?.slice("--target=".length) ?? (targetIndex === -1 ? undefined : process.argv[targetIndex + 1])
if ((inlineTargetArgument || targetIndex !== -1) && (!targetArgument || targetArgument.startsWith("--"))) {
  throw new Error("--target requires a comma-separated target list")
}
const targetValues = targetArgument?.split(",").map((value) => value.trim()) ?? []
if (targetValues.some((value) => !value)) throw new Error("--target cannot contain an empty target name")
if (new Set(targetValues).size !== targetValues.length)
  throw new Error("--target cannot contain duplicate target names")
const requestedTargets = new Set(targetValues)
const plugin = createSolidTransformPlugin()
const cveDictionaryTextOnlyPlugin: Bun.BunPlugin = {
  name: "cve-dictionary-text-only-transformers",
  setup(builder) {
    builder.onResolve({ filter: /^sharp$/ }, () => ({
      path: path.join(dir, "src/cve-dictionary/sharp-text-only.ts"),
    }))
  },
}

// ── One Invocation Has One Build Identity ─────────────────────
// Every target emitted by this process must embed the same identity so caches and
// diagnostics agree across the release set. CI supplies a reproducible identifier;
// local builds use a fresh suffix so rebuilding one package version cannot reuse
// runtime state created by an older binary with different source.
// ────────────────────────────────────────────────────────────────
const buildID = releaseBuildID()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

interface EmbeddedOnnxRuntimeLibrary {
  readonly bytes: number
  readonly sha256: string
  readonly base64: string
}

// ── Each Binary Carries Only Its Matching ONNX Shared Libraries ───
// Transformers.js already selects the target-specific Node-API binding while Bun
// bundles it. The dynamic loader also needs that binding's sibling libraries;
// resolve them through Transformers.js's pinned dependency graph and encode only
// the non-binding files for the platform currently being compiled.
// → cyberful/src/cve-dictionary/embedding.ts — verifies and restores these assets.
// ─────────────────────────────────────────────────────────────────
const transformersEntry = fileURLToPath(import.meta.resolve("@huggingface/transformers"))
const transformersPackageRoot = path.dirname(path.dirname(transformersEntry))
const onnxRuntimePackageRoot = fs.realpathSync(path.resolve(transformersPackageRoot, "..", "..", "onnxruntime-node"))

function embeddedOnnxRuntime(item: (typeof allTargets)[number]): Record<string, EmbeddedOnnxRuntimeLibrary> {
  const nativeDirectory = path.join(onnxRuntimePackageRoot, "bin", "napi-v3", item.os, item.arch)
  const entries = fs.readdirSync(nativeDirectory, { withFileTypes: true })
  const libraries: Record<string, EmbeddedOnnxRuntimeLibrary> = {}
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "onnxruntime_binding.node") continue
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    const content = fs.readFileSync(path.join(nativeDirectory, entry.name))
    libraries[entry.name] = {
      bytes: content.byteLength,
      sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
      base64: content.toString("base64"),
    }
  }
  if (Object.keys(libraries).length === 0) {
    throw new Error(`No ONNX Runtime libraries found for ${item.os}/${item.arch}`)
  }
  return libraries
}

const targetName = (item: (typeof allTargets)[number]) =>
  [
    pkg.name,
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi,
  ]
    .filter(Boolean)
    .join("-")

function compileTarget(item: (typeof allTargets)[number]): Bun.Build.CompileTarget {
  if (item.os === "darwin") {
    if (item.avx2 === false) return item.arch === "arm64" ? "bun-darwin-arm64-baseline" : "bun-darwin-x64-baseline"
    return item.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
  }
  if (item.os === "win32") {
    if (item.avx2 === false) {
      if (item.arch !== "x64") throw new Error(`Bun has no baseline Windows target for ${item.arch}`)
      return "bun-windows-x64-baseline"
    }
    return item.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64"
  }
  if (item.os !== "linux") throw new Error(`Unsupported Bun build operating system: ${item.os}`)
  if (item.abi === "musl") {
    if (item.avx2 === false)
      return item.arch === "arm64" ? "bun-linux-arm64-baseline-musl" : "bun-linux-x64-baseline-musl"
    return item.arch === "arm64" ? "bun-linux-arm64-musl" : "bun-linux-x64-musl"
  }
  if (item.avx2 === false) return item.arch === "arm64" ? "bun-linux-arm64-baseline" : "bun-linux-x64-baseline"
  return item.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64"
}

const targets = requestedTargets.size
  ? allTargets.filter((item) => requestedTargets.has(targetName(item)))
  : singleFlag
    ? allTargets.filter((item) => {
        if (item.os !== process.platform || item.arch !== process.arch) {
          return false
        }

        if (item.avx2 === false) {
          return baselineFlag
        }

        if (item.abi !== undefined) {
          return false
        }

        return true
      })
    : allTargets

if (requestedTargets.size && targets.length !== requestedTargets.size) {
  const known = new Set(targets.map(targetName))
  throw new Error(`Unknown build target(s): ${[...requestedTargets].filter((name) => !known.has(name)).join(", ")}`)
}
if (requestedTargets.size && targets.some((item) => item.os !== process.platform || item.arch !== process.arch)) {
  throw new Error("Explicit --target builds must run on the target operating system and architecture")
}

await fs.promises.rm(path.join(dir, "dist"), { recursive: true, force: true })

// ── One Build Resolves One Official ATT&CK Snapshot ──────────────
// Local builds resolve the latest Enterprise, Mobile, and ICS collections once
// before compiling any target. Release matrix jobs may consume one prepared
// directory from the snapshot job, but they still verify and embed its exact
// bytes; neither path permits a runtime download or a stale-cache fallback.
// → cyberful/src/bootstrap-mitre-attack.ts — restores these bytes offline.
// @docs/runtimes/mitre-attack.md
// ─────────────────────────────────────────────────────────────────
const attackOutput = path.join(dir, "dist", "mitre-attack")
const preparedAttack = process.env.CYBERFUL_MITRE_ATTACK_SNAPSHOT_DIR?.trim()
await fs.promises.mkdir(path.dirname(attackOutput), { recursive: true })
if (preparedAttack) {
  const source = fs.realpathSync(preparedAttack)
  if (!fs.statSync(source).isDirectory()) throw new Error("CYBERFUL_MITRE_ATTACK_SNAPSHOT_DIR must be a directory")
  embeddedAttackSnapshot(source)
  await fs.promises.cp(source, attackOutput, { recursive: true, errorOnExist: true, force: false })
} else {
  await buildAttackSnapshot({
    outputDir: attackOutput,
    cyberfulVersion: Script.version,
    buildID,
  })
}
const embeddedAttack = embeddedAttackSnapshot(attackOutput)
const frameworkIdentifiers: unknown = JSON.parse(
  fs.readFileSync(path.join(Builtin.DIR, "skills", "framework-identifiers.json"), "utf8"),
)
if (
  typeof frameworkIdentifiers !== "object" ||
  frameworkIdentifiers === null ||
  !("frameworks" in frameworkIdentifiers) ||
  typeof frameworkIdentifiers.frameworks !== "object" ||
  frameworkIdentifiers.frameworks === null ||
  !("mitre_attack" in frameworkIdentifiers.frameworks) ||
  typeof frameworkIdentifiers.frameworks.mitre_attack !== "object" ||
  frameworkIdentifiers.frameworks.mitre_attack === null ||
  !("identifiers" in frameworkIdentifiers.frameworks.mitre_attack) ||
  !Array.isArray(frameworkIdentifiers.frameworks.mitre_attack.identifiers) ||
  !frameworkIdentifiers.frameworks.mitre_attack.identifiers.every((item) => typeof item === "string")
) {
  throw new Error("Built-in MITRE ATT&CK routing identifiers are invalid")
}
validateAttackRoutingIdentifiers(
  path.join(attackOutput, embeddedAttack.manifest.database.file),
  frameworkIdentifiers.frameworks.mitre_attack.identifiers,
)
await fs.promises.writeFile(
  path.join(dir, "dist", "mitre-attack-manifest.json"),
  `${JSON.stringify(embeddedAttack.manifest, null, 2)}\n`,
)
console.log(
  `Embedding MITRE ATT&CK ${embeddedAttack.manifest.domains.map((item) => `${item.domain}=${item.version}`).join(" ")} (${embeddedAttack.manifest.snapshot_id})`,
)

if (!skipInstall) {
  await runBuildCommand(["bun", "install", "--os=*", "--cpu=*", `@opentui/core@${pkg.dependencies["@opentui/core"]}`])
  await runBuildCommand([
    "bun",
    "install",
    "--os=*",
    "--cpu=*",
    `@parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`,
  ])
}

for (const [packageName, expectedVersion] of [
  ["@earendil-works/pi-agent-core", embeddedRuntimeVersions.piAgentCore],
  ["@earendil-works/pi-ai", embeddedRuntimeVersions.piAi],
] as const) {
  const installedVersion = installedPackageVersion(packageName)
  if (installedVersion !== expectedVersion) {
    throw new Error(`${packageName} resolved to ${installedVersion}; Cyberful pins ${expectedVersion}`)
  }
}

// ── Standalone Binaries Never Capture The Build Environment ─────────
// The launch directory's `.env` is a runtime-only input and may contain provider
// API keys or engagement configuration. Keep the compiled default empty so a
// release artifact cannot retain secrets from the machine that built it.
// Runtime bootstrap alone applies process and launch-directory environment layers.
// → cyberful/src/bootstrap-env.ts — reads the operator's runtime `.env`.
// ─────────────────────────────────────────────────────────────────────
const embeddedEnv = ""

// ── Built-In Configuration Excludes Runtime State ────────────────────
// Personas, skills, instructions, and first-party configuration must ship with
// each binary. Workareas, logs, reports, inputs, examples, and non-text assets
// are excluded so a build cannot capture mutable engagement state. Startup then
// materializes only this reviewed immutable map.
// → cyberful/src/bootstrap-config.ts — materializes the embedded configuration.
// ─────────────────────────────────────────────────────────────────────
const embeddedConfig: Record<string, string> = {}
if (!fs.existsSync(path.join(Builtin.DIR, "cyberful.json"))) {
  throw new Error(`Built-in configuration not found at ${Builtin.DIR}`)
}
const CONFIG_TEXT_EXT = new Set([
  ".cjs",
  ".js",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
])
const EXCLUDE_TOP = new Set(["work", "logs", "reports", "inputs", "example"])
const EXCLUDE_SEGMENTS = new Set(["__pycache__", "tests"])
for (const rel of await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: Builtin.DIR, onlyFiles: true }))) {
  const norm = rel.replaceAll("\\", "/")
  const segments = norm.split("/")
  if (
    EXCLUDE_TOP.has(segments[0] ?? "") ||
    segments.some((segment) => EXCLUDE_SEGMENTS.has(segment)) ||
    norm === "README.md" ||
    norm === ".gitignore"
  )
    continue
  if (!CONFIG_TEXT_EXT.has(path.extname(norm))) continue
  embeddedConfig[norm] = await Bun.file(path.join(Builtin.DIR, rel)).text()
}
console.log(`Embedding ${Object.keys(embeddedConfig).length} built-in config files`)

// ── Releases Carry One Complete Local Runtime Recipe ─────────────
// Published binaries do not depend on a Cyberful container registry. The small
// first-party Docker context is embedded byte-for-byte and materialized on first
// use, while large third-party layers remain checksum-pinned Docker build inputs.
// A normalized content hash, independent of the CLI version, lets UI-only releases
// reuse the already attested local image.
// → cyberful/src/bootstrap-config.ts — restores the context atomically.
// ─────────────────────────────────────────────────────────────────────
const runtimeContextRoot = path.resolve(dir, "../mcps")
const embeddedCyberfulOs: Record<string, string> = {}
const runtimeExcludedSegments = new Set([".git", "__pycache__", "node_modules", "tests", "browser"])
const runtimeExcludedFiles = new Set([
  "package-lock.json",
  "cyberful-os/docker-compose.yml",
  "ghidra/Dockerfile",
  "ghidra/Dockerfile.bridge",
  "zap/Dockerfile",
  "zap/Dockerfile.bridge",
])
for (const rel of await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: runtimeContextRoot, onlyFiles: true }))) {
  const norm = rel.replaceAll("\\", "/")
  const segments = norm.split("/")
  if (segments.some((segment) => runtimeExcludedSegments.has(segment))) continue
  if (runtimeExcludedFiles.has(norm) || norm.endsWith(".test.mjs")) continue
  embeddedCyberfulOs[norm] = Buffer.from(await Bun.file(path.join(runtimeContextRoot, rel)).arrayBuffer()).toString(
    "base64",
  )
}
if (!embeddedCyberfulOs["cyberful-os/Dockerfile"] || !embeddedCyberfulOs["cyberful-os/bin/cyberful-os-build"])
  throw new Error("Complete cyberful-os runtime context is unavailable")
const runtimeFingerprintHash = createHash("sha256")
for (const [rel, content] of Object.entries(embeddedCyberfulOs).sort(([left], [right]) => left.localeCompare(right))) {
  runtimeFingerprintHash.update(rel).update("\0").update(content).update("\0")
}
const runtimeFingerprint = runtimeFingerprintHash.digest("hex")
console.log(`Embedding ${Object.keys(embeddedCyberfulOs).length} runtime files (${runtimeFingerprint.slice(0, 12)})`)
await fs.promises.mkdir(path.join(dir, "dist"), { recursive: true })
await fs.promises.writeFile(
  path.join(dir, "dist", "runtime-manifest.json"),
  `${JSON.stringify({ version: 1, fingerprint: runtimeFingerprint, files: Object.keys(embeddedCyberfulOs).sort() }, null, 2)}\n`,
)

// ── agent-browser Embedding Preserves Binary Assets ──────────────────
// The pinned agent-browser package, matching native binary, skill data, license,
// and first-party CAPTCHA plugin ship inside Cyberful. Bootstrap recreates that
// exact layout in a build-specific cache. Binary assets use base64 so bundling
// cannot corrupt bytes.
// → cyberful/src/bootstrap-browser.ts — materializes and verifies this cache.
// ─────────────────────────────────────────────────────────────────────
const BROWSER_BIN_EXT = new Set([
  "ttf",
  "otf",
  "woff",
  "woff2",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "ico",
  "wasm",
  "node",
  "so",
  "dylib",
  "exe",
  "gz",
  "zip",
  "br",
])
const embeddedBrowser: Record<string, string> = {}
const embeddedBrowserBin: Record<string, string> = {}
const bakeBrowserTree = async (root: string, prefix: string) => {
  if (!fs.existsSync(root)) return
  const EXCLUDE_SEG = new Set([".git", ".browsers", "__pycache__"])
  for (const rel of await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true }))) {
    const norm = rel.replaceAll("\\", "/")
    if (norm.split("/").some((seg) => EXCLUDE_SEG.has(seg))) continue
    const key = `${prefix}/${norm}`
    const file = Bun.file(path.join(root, rel))
    if (BROWSER_BIN_EXT.has(norm.split(".").pop()?.toLowerCase() ?? "") || /(?:^|\/)agent-browser-[^/]+$/u.test(norm)) {
      embeddedBrowserBin[key] = Buffer.from(await file.arrayBuffer()).toString("base64")
    } else {
      embeddedBrowser[key] = await file.text()
    }
  }
}
await bakeBrowserTree(path.resolve(dir, "../mcps/browser"), "browser")
await bakeBrowserTree(path.resolve(dir, "../mcps/node_modules/agent-browser"), "node_modules/agent-browser")
console.log(
  `Embedding browser MCP: ${Object.keys(embeddedBrowser).length} text + ${Object.keys(embeddedBrowserBin).length} binary files`,
)

function agentBrowserBinaryForTarget(item: (typeof targets)[number]): string {
  if (item.os === "darwin")
    return item.arch === "arm64" ? "agent-browser-darwin-arm64" : "agent-browser-darwin-x64"
  if (item.os === "win32") return "agent-browser-win32-x64.exe"
  const libc = item.abi === "musl" ? "linux-musl" : "linux"
  return item.arch === "arm64" ? `agent-browser-${libc}-arm64` : `agent-browser-${libc}-x64`
}

function embeddedBrowserBinariesForTarget(item: (typeof targets)[number]): Record<string, string> {
  const selected = agentBrowserBinaryForTarget(item)
  return Object.fromEntries(
    Object.entries(embeddedBrowserBin).filter(
      ([key]) => !key.includes("node_modules/agent-browser/bin/agent-browser-") || key.endsWith(`/${selected}`),
    ),
  )
}

async function embeddedCaptchaPluginForTarget(item: (typeof targets)[number], name: string) {
  const extension = item.os === "win32" ? ".exe" : ""
  const output = path.join(dir, "dist", name, "bin", `agent-browser-plugin-captcha${extension}`)
  const build = await Bun.build({
    entrypoints: [path.resolve(dir, "../mcps/browser/plugin-captcha/agent-browser-plugin-captcha.mjs")],
    minify: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      target: compileTarget(item),
      outfile: output,
    },
  })
  if (!build.success) {
    throw new Error(`Bun failed to build CAPTCHA plugin for ${name}:\n${build.logs.map((entry) => String(entry)).join("\n")}`)
  }
  return {
    key: `browser/bin/agent-browser-plugin-captcha${extension}`,
    base64: fs.readFileSync(output).toString("base64"),
  }
}

for (const item of targets) {
  const name = targetName(item)
  console.log(`building ${name}`)
  await fs.promises.mkdir(path.join(dir, "dist", name, "bin"), { recursive: true })

  const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
  const rootPath = path.resolve(dir, "../node_modules/@opentui/core/parser.worker.js")
  const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
  const workerPath = "./src/cli/cmd/tui/worker.ts"
  const cveDictionaryIntegrityWorkerPath = "./src/cve-dictionary/integrity-worker.ts"

  // ── The Gateway Is A First-Class Binary Entrypoint ───────────────
  // A compiled phase launches its private gateway by re-entering the binary through
  // Bun's script mode. Including the gateway beside the TUI worker keeps that module
  // addressable after bundling and splitting. Omitting it would produce a successful
  // main binary whose required expert-gateway MCP can never start.
  // ────────────────────────────────────────────────────────────────
  const gatewayPath = "./src/subsystem/gateway/server.ts"
  const mitreAttackPath = "./src/subsystem/mitre-attack/server.ts"
  const embeddedOnnx = embeddedOnnxRuntime(item)
  const embeddedAgentBrowserBin = embeddedBrowserBinariesForTarget(item)
  const captchaPlugin = await embeddedCaptchaPluginForTarget(item, name)
  embeddedAgentBrowserBin[captchaPlugin.key] = captchaPlugin.base64
  console.log(`Embedding ${Object.keys(embeddedOnnx).length} ONNX Runtime libraries for ${item.os}/${item.arch}`)

  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

  const build = await Bun.build({
    conditions: ["browser"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin, cveDictionaryTextOnlyPlugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: compileTarget(item),
      outfile: `dist/${name}/bin/cyberful`,
      execArgv: [`--user-agent=cyberful/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    entrypoints: [
      "./src/index.ts",
      parserWorker,
      workerPath,
      gatewayPath,
      mitreAttackPath,
      cveDictionaryIntegrityWorkerPath,
    ],
    define: {
      CYBERFUL_VERSION: `'${Script.version}'`,
      CYBERFUL_BUILD_ID: JSON.stringify(buildID),
      CYBERFUL_MIGRATIONS: JSON.stringify(migrations),
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
      CYBERFUL_WORKER_PATH: workerPath,
      CYBERFUL_CVE_DICTIONARY_INTEGRITY_WORKER_PATH: cveDictionaryIntegrityWorkerPath,
      // ── Release Gateways Re-Enter The Stable Main Binary ────────
      // Standalone builds hash secondary-entrypoint chunks, so their source-relative
      // paths are not stable release addresses. This marker makes the gateway invoke
      // the compiled main entrypoint with its private argument instead. Development
      // remains free to launch the direct source entrypoint without that indirection.
      // → cyberful/src/subsystem/gateway/config.ts — defines the re-entry argument.
      // ─────────────────────────────────────────────────────────────────
      CYBERFUL_BUILT: JSON.stringify("1"),
      CYBERFUL_CHANNEL: `'${Script.channel}'`,
      CYBERFUL_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      CYBERFUL_EMBEDDED_ENV: JSON.stringify(embeddedEnv),
      CYBERFUL_EMBEDDED_CONFIG: JSON.stringify(embeddedConfig),
      CYBERFUL_EMBEDDED_CYBERFUL_OS: JSON.stringify(embeddedCyberfulOs),
      CYBERFUL_RUNTIME_FINGERPRINT: JSON.stringify(runtimeFingerprint),
      CYBERFUL_EMBEDDED_BROWSER: JSON.stringify(embeddedBrowser),
      CYBERFUL_EMBEDDED_BROWSER_BIN: JSON.stringify(embeddedAgentBrowserBin),
      CYBERFUL_EMBEDDED_ONNX_RUNTIME: JSON.stringify(embeddedOnnx),
      CYBERFUL_EMBEDDED_MITRE_ATTACK: JSON.stringify(embeddedAttack),
    },
  })
  if (!build.success) {
    throw new Error(`Bun failed to build ${name}:\n${build.logs.map((entry) => String(entry)).join("\n")}`)
  }

  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/cyberful${item.os === "win32" ? ".exe" : ""}`
    console.log(`Running smoke test: ${binaryPath} --version`)
    const smoke = Bun.spawn([binaryPath, "--version"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      maxBuffer: 1_048_576,
    })
    const [versionOutput, errorOutput, exitCode] = await Promise.all([
      new Response(smoke.stdout).text(),
      new Response(smoke.stderr).text(),
      smoke.exited,
    ])
    if (exitCode !== 0) {
      throw new Error(`Smoke test failed for ${name} with status ${exitCode}: ${errorOutput.trim()}`)
    }
    console.log(`Smoke test passed: ${versionOutput.trim()}`)

    const runtimeSmoke = Bun.spawn([binaryPath, RUNTIME_VERSION_ARGV], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      maxBuffer: 1_048_576,
    })
    const [runtimeOutput, runtimeError, runtimeExitCode] = await Promise.all([
      new Response(runtimeSmoke.stdout).text(),
      new Response(runtimeSmoke.stderr).text(),
      runtimeSmoke.exited,
    ])
    if (runtimeExitCode !== 0) {
      throw new Error(
        `Embedded Pi smoke test failed for ${name} with status ${runtimeExitCode}: ${runtimeError.trim()}`,
      )
    }
    const reportedRuntime = decodeRuntimeVersions(runtimeOutput)
    if (
      reportedRuntime.piAgentCore !== embeddedRuntimeVersions.piAgentCore ||
      reportedRuntime.piAi !== embeddedRuntimeVersions.piAi
    )
      throw new Error(
        `Embedded Pi mismatch for ${name}: expected agent=${embeddedRuntimeVersions.piAgentCore}, ai=${embeddedRuntimeVersions.piAi}; received agent=${reportedRuntime.piAgentCore}, ai=${reportedRuntime.piAi}`,
      )
    console.log(`Embedded Pi smoke test passed: agent=${reportedRuntime.piAgentCore}, ai=${reportedRuntime.piAi}`)
  }

  await fs.promises.rm(path.join(dir, "dist", name, "bin", "tui"), { recursive: true, force: true })
}
