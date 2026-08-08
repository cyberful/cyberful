#!/usr/bin/env bun
// ── Standalone Binary Build Pipeline ────────────────────────────────
// Compiles each supported Cyberful target, embeds its host-side first-party
// assets and runtime-image digest, then applies compatibility launch smoke tests.
// → cyberful/src/bootstrap-config.ts — materializes the embedded host launchers.
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
const CONFIG_TEXT_EXT = new Set([".md", ".json", ".jsonc", ".txt", ".yaml", ".yml"])
const EXCLUDE_TOP = new Set(["work", "logs", "reports", "inputs", "example"])
for (const rel of await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: Builtin.DIR, onlyFiles: true }))) {
  const norm = rel.replaceAll("\\", "/")
  if (EXCLUDE_TOP.has(norm.split("/")[0]) || norm === "README.md" || norm === ".gitignore") continue
  if (!CONFIG_TEXT_EXT.has(path.extname(norm))) continue
  embeddedConfig[norm] = await Bun.file(path.join(Builtin.DIR, rel)).text()
}
console.log(`Embedding ${Object.keys(embeddedConfig).length} built-in config files`)

// ── Releases Embed Only The Host-Side Runtime Launcher ───────────
// The security-tool filesystem ships as one signed GHCR image rather than source
// Docker contexts inside every platform binary. Releases retain only the stdio
// MCP launcher and its Python protocol implementation; a source checkout still
// owns the Dockerfile, supervisor, bridges, wordlists, and contributor build path.
// → cyberful/src/bootstrap-config.ts — restores the embedded toolkit on first use.
// ─────────────────────────────────────────────────────────────────────
const cyberfulOsRoot = path.resolve(dir, "../mcps/cyberful-os")
const embeddedCyberfulOs: Record<string, string> = {}
if (fs.existsSync(cyberfulOsRoot)) {
  for (const rel of ["bin/cyberful-os", "cyberful_os_mcp.py", "mcp_framing.py"]) {
    const file = path.join(cyberfulOsRoot, rel)
    if (!fs.existsSync(file)) throw new Error(`Host runtime asset not found: ${file}`)
    embeddedCyberfulOs[rel] = await Bun.file(file).text()
  }
}
console.log(`Embedding ${Object.keys(embeddedCyberfulOs).length} cyberful-os files`)

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
  const embeddedOnnx = embeddedOnnxRuntime(item)
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
      CYBERFUL_RUNTIME_IMAGE: JSON.stringify(process.env.CYBERFUL_RUNTIME_IMAGE?.trim() ?? ""),
      CYBERFUL_EMBEDDED_BROWSER: JSON.stringify(embeddedBrowser),
      CYBERFUL_EMBEDDED_BROWSER_BIN: JSON.stringify(embeddedBrowserBin),
      CYBERFUL_EMBEDDED_ONNX_RUNTIME: JSON.stringify(embeddedOnnx),
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
