#!/usr/bin/env bun
// ── Standalone Binary Build Pipeline ────────────────────────────────
// Compiles each supported Cyberful target, embeds its first-party runtime
// assets, and rejects artifacts that fail compatibility or launch smoke tests.
// → cyberful/src/bootstrap-config.ts — materializes the embedded runtime assets.
// → scripts/release.ts — supplies the immutable version and channel identity.
// ────────────────────────────────────────────────────────────────────

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { Script } from "../../scripts/release"
import pkg from "../package.json"
import * as Builtin from "../src/builtin"
import { removeBunBuildArtifacts } from "./bun-build-artifacts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

function booleanEnvironment(name: string) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return false
  const value = raw.trim().toLowerCase()
  if (value === "1" || value === "true") return true
  if (value === "0" || value === "false") return false
  throw new Error(`${name} must be one of: 1, true, 0, false`)
}

function releaseBuildID() {
  const configured = process.env.CYBERFUL_BUILD_ID?.trim()
  if (!configured) return `${Script.version}-${crypto.randomUUID()}`
  if (configured.length > 256 || /[\u0000-\u001f\u007f]/.test(configured)) {
    throw new Error("CYBERFUL_BUILD_ID must be at most 256 printable characters")
  }
  return configured
}

async function optionalTextFile(file: string) {
  try {
    return await Bun.file(file).text()
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""
    throw new Error(`Cannot read optional build input ${file}`, { cause: error })
  }
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

// ── One Invocation Has One Build Identity ─────────────────────
// Every target emitted by this process must embed the same identity so caches and
// diagnostics agree across the release set. CI supplies a reproducible identifier;
// local builds use a fresh suffix so rebuilding one package version cannot reuse
// runtime state created by an older binary with different source.
// ────────────────────────────────────────────────────────────────
const buildID = releaseBuildID()

// ── Standalone Builds Require The Codex Runtime Contract ─────────────
// A distributable binary is valid only when the host Codex satisfies the pinned
// version, strict configuration, app-server JSON-RPC, and MCP round-trip contract.
// The suite stops before a model turn, so no login is required. Cross-build hosts
// may explicitly bypass it, but ordinary builds fail before producing artifacts.
// ─────────────────────────────────────────────────────────────────────
if (!booleanEnvironment("CYBERFUL_SKIP_CODEX_COMPAT")) {
  console.log("Verifying the pinned Codex version and compatibility contract…")
  const compat = Bun.spawnSync(["bun", "run", "test-codex"], {
    cwd: dir,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
    timeout: 120_000,
  })
  if (compat.exitCode !== 0) {
    throw new Error(
      "Codex compatibility check failed; run `make subsystems`, install the pinned version, or explicitly set " +
        "CYBERFUL_SKIP_CODEX_COMPAT=1 to bypass the release gate",
    )
  }
}

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

// ── Embedded Environment Is A Lowest-Precedence Default ──────────────
// Standalone binaries carry the ignored repository `.env`, or an empty value in
// CI, but never the placeholder `.env-example`. Variables resolved by runtime
// bootstrap are removed so development values cannot override embedded paths.
// Source launches still read the live file; this layer exists only in binaries.
// → cyberful/src/bootstrap-env.ts — applies the embedded defaults at startup.
// ─────────────────────────────────────────────────────────────────────
const BAKE_ENV_SKIP = new Set(["CYBERFUL_OS_DIR"])
const embeddedEnv = (await optionalTextFile(path.resolve(dir, "../.env")))
  .split("\n")
  .filter((entry) => {
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(entry)?.[1]
    return !key || !BAKE_ENV_SKIP.has(key)
  })
  .join("\n")

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
const CONFIG_TEXT_EXT = new Set([".md", ".json", ".jsonc", ".txt", ".yaml", ".yml"])
const EXCLUDE_TOP = new Set(["work", "logs", "reports", "inputs", "example"])
for (const rel of await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: Builtin.DIR, onlyFiles: true }))) {
  const norm = rel.replaceAll("\\", "/")
  if (EXCLUDE_TOP.has(norm.split("/")[0]) || norm === "README.md" || norm === ".gitignore") continue
  if (!CONFIG_TEXT_EXT.has(path.extname(norm))) continue
  embeddedConfig[norm] = await Bun.file(path.join(Builtin.DIR, rel)).text()
}
console.log(`Embedding ${Object.keys(embeddedConfig).length} built-in config files`)

// ── cyberful-os Ships As A Self-Contained Text Toolkit ──────────────────
// Installed Cyberful must build and launch cyberful-os without a source checkout,
// so each binary embeds its scripts, runtime definitions, and wordlists. Tests,
// caches, and bytecode are excluded; the remaining files are treated as text and
// launcher permissions are restored only when bootstrap materializes them.
// → cyberful/src/bootstrap-config.ts — restores the embedded toolkit on first use.
// ─────────────────────────────────────────────────────────────────────
const cyberfulOsRoot = path.resolve(dir, "../mcps/cyberful-os")
const embeddedCyberfulOs: Record<string, string> = {}
if (fs.existsSync(cyberfulOsRoot)) {
  const EXCLUDE_SEG = new Set(["__pycache__", "tests", ".git"])
  for (const rel of await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: cyberfulOsRoot, onlyFiles: true }))) {
    const norm = rel.replaceAll("\\", "/")
    if (norm.split("/").some((seg) => EXCLUDE_SEG.has(seg)) || norm.endsWith(".pyc")) continue
    embeddedCyberfulOs[norm] = await Bun.file(path.join(cyberfulOsRoot, rel)).text()
  }
}
console.log(`Embedding ${Object.keys(embeddedCyberfulOs).length} cyberful-os files`)

// ── ZAP Build Contexts Travel With The Binary ────────────────────────
// ZAP executes from pinned OCI images rather than embedded application code.
// The source build contexts still travel inside Cyberful so first startup can
// reproduce both the headless runtime and stdio bridge without a checkout.
// Generated dependencies and repository metadata stay outside that context.
// ─────────────────────────────────────────────────────────────────────
const zapRoot = path.resolve(dir, "../mcps/zap")
const embeddedZap: Record<string, string> = {}
if (fs.existsSync(zapRoot)) {
  for (const rel of await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: zapRoot, onlyFiles: true }))) {
    const norm = rel.replaceAll("\\", "/")
    if (norm.split("/").some((segment) => segment === "node_modules" || segment === ".git")) continue
    embeddedZap[norm] = await Bun.file(path.join(zapRoot, rel)).text()
  }
}
console.log(`Embedding ${Object.keys(embeddedZap).length} ZAP container files`)

// ── Browser Driver Embedding Preserves Binary Assets ─────────────────
// The browser MCP and Patchright driver ship inside Cyberful; only Chromium is
// fetched at first use. Bootstrap recreates the exact launcher layout in a
// build-specific cache. Text remains text, while driver fonts, images, native
// modules, and compressed assets use base64 so bundling cannot corrupt bytes.
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
    if (BROWSER_BIN_EXT.has(norm.split(".").pop()?.toLowerCase() ?? "")) {
      embeddedBrowserBin[key] = Buffer.from(await file.arrayBuffer()).toString("base64")
    } else {
      embeddedBrowser[key] = await file.text()
    }
  }
}
await bakeBrowserTree(path.resolve(dir, "../mcps/browser"), "browser")
await bakeBrowserTree(path.resolve(dir, "../mcps/node_modules/patchright-core"), "node_modules/patchright-core")
console.log(
  `Embedding browser MCP: ${Object.keys(embeddedBrowser).length} text + ${Object.keys(embeddedBrowserBin).length} binary files`,
)

for (const item of targets) {
  const name = targetName(item)
  console.log(`building ${name}`)
  await fs.promises.mkdir(path.join(dir, "dist", name, "bin"), { recursive: true })

  const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
  const rootPath = path.resolve(dir, "../node_modules/@opentui/core/parser.worker.js")
  const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
  const workerPath = "./src/cli/cmd/tui/worker.ts"

  // ── The Gateway Is A First-Class Binary Entrypoint ───────────────
  // A compiled phase launches its private gateway by re-entering the binary through
  // Bun's script mode. Including the gateway beside the TUI worker keeps that module
  // addressable after bundling and splitting. Omitting it would produce a successful
  // main binary whose required expert-gateway MCP can never start.
  // ────────────────────────────────────────────────────────────────
  const gatewayPath = "./src/subsystem/gateway/server.ts"

  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

  const build = await Bun.build({
    conditions: ["browser"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
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
    entrypoints: ["./src/index.ts", parserWorker, workerPath, gatewayPath],
    define: {
      CYBERFUL_VERSION: `'${Script.version}'`,
      CYBERFUL_BUILD_ID: JSON.stringify(buildID),
      CYBERFUL_MIGRATIONS: JSON.stringify(migrations),
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
      CYBERFUL_WORKER_PATH: workerPath,
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
      CYBERFUL_EMBEDDED_ZAP: JSON.stringify(embeddedZap),
      CYBERFUL_EMBEDDED_BROWSER: JSON.stringify(embeddedBrowser),
      CYBERFUL_EMBEDDED_BROWSER_BIN: JSON.stringify(embeddedBrowserBin),
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
  }

  await fs.promises.rm(path.join(dir, "dist", name, "bin", "tui"), { recursive: true, force: true })
}
