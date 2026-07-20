// ── Disposable Code Audit Runtime Lab ───────────────────────────
// Bootstraps declared dependencies with manifests only, destroys the networked
// container, and then materializes the sealed source into an offline workarea
// tree consumed by cyberful-os. No user checkout or host credential is mounted.
// → cyberful/src/subsystem/gateway/server.ts — exposes prepare and owns cleanup.
// ────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { lstat, mkdir, realpath, rm } from "node:fs/promises"
import { replaceWorkareaFile } from "@/workarea"
import { materializeSourceForAuditLab } from "./source-tools"

const MAX_DOCKER_OUTPUT = 512 * 1024
const BOOTSTRAP_TIMEOUT_MS = 15 * 60_000
const LAB_ROOT = ".cyberful-lab"
const activeLabs = new Set<string>()
let preparationTail: Promise<void> = Promise.resolve()

export const AUDIT_LAB_TOOL_DEF = {
  name: "audit_lab_prepare",
  description:
    "Prepare a disposable Code Audit lab. Declared dependencies are installed automatically in a source-blind, credential-free container; after it exits, the sealed source is materialized for offline execution and attack in cyberful-os.",
  inputSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        maxLength: 1_024,
        description: "Optional relative project component to materialize; defaults to the repository root.",
      },
      bootstrap: {
        type: "string",
        enum: ["auto", "none"],
        default: "auto",
        description: "Install dependencies from recognized lockfiles/manifests, or skip dependency bootstrap.",
      },
    },
  },
} as const

interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly timedOut: boolean
}

interface BootstrapAdapter {
  readonly name: string
  readonly command: string
  readonly environment?: Readonly<Record<string, string>>
}

function isContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function requestedPath(value: unknown) {
  if (value === undefined || value === "") return ""
  if (typeof value !== "string" || path.isAbsolute(value) || value.includes("\0"))
    throw new Error("audit lab path must be relative")
  const normalized = path.normalize(value)
  if (normalized.split(path.sep).includes("..")) throw new Error("audit lab path escapes the source root")
  return normalized === "." ? "" : normalized
}

async function plainDirectory(root: string, relative: string) {
  let current = root
  for (const segment of relative.split("/").filter(Boolean)) {
    current = path.join(current, segment)
    const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!entry) await mkdir(current, { mode: 0o700 })
    const created = await lstat(current)
    if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("audit lab path is unsafe")
    if (!isContained(root, await realpath(current))) throw new Error("audit lab path escapes the workarea")
  }
  return current
}

async function readBounded(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return { text: "", truncated: false }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let retained = 0
  let truncated = false
  while (true) {
    const next = await reader.read()
    if (next.done) break
    if (retained >= MAX_DOCKER_OUTPUT) {
      truncated = true
      continue
    }
    const remaining = MAX_DOCKER_OUTPUT - retained
    const chunk = next.value.byteLength <= remaining ? next.value : next.value.slice(0, remaining)
    chunks.push(chunk)
    retained += chunk.byteLength
    truncated ||= chunk.byteLength !== next.value.byteLength
  }
  const bytes = new Uint8Array(retained)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(bytes), truncated }
}

function dockerEnvironment() {
  const environment = { ...process.env }
  const isolatedConfig = process.env.CYBERFUL_OS_DOCKER_CONFIG?.trim()
  if (isolatedConfig) environment.DOCKER_CONFIG = isolatedConfig
  const desktopSocket = path.join(homedir(), ".docker", "run", "docker.sock")
  if (!environment.DOCKER_HOST && !environment.DOCKER_CONTEXT && existsSync(desktopSocket))
    environment.DOCKER_HOST = `unix://${desktopSocket}`
  return environment
}

async function docker(argv: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn(["docker", ...argv], {
    env: dockerEnvironment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, BOOTSTRAP_TIMEOUT_MS)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout),
      readBounded(child.stderr),
      child.exited,
    ])
    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      timedOut,
    }
  } finally {
    clearTimeout(timer)
  }
}

function rootManifests(files: readonly string[]) {
  return new Set(files.filter((file) => !file.includes("/")).map((file) => path.basename(file)))
}

function bootstrapAdapters(files: readonly string[]): BootstrapAdapter[] {
  const manifests = rootManifests(files)
  const adapters: BootstrapAdapter[] = []
  if (manifests.has("pnpm-lock.yaml")) {
    adapters.push({ name: "pnpm", command: "corepack pnpm install --frozen-lockfile --ignore-scripts" })
  } else if (manifests.has("yarn.lock")) {
    adapters.push({ name: "yarn", command: "corepack yarn install --immutable --mode=skip-builds" })
  } else if (manifests.has("bun.lock") || manifests.has("bun.lockb")) {
    adapters.push({ name: "bun", command: "bun install --frozen-lockfile --ignore-scripts" })
  } else if (manifests.has("package-lock.json") || manifests.has("npm-shrinkwrap.json")) {
    adapters.push({ name: "npm", command: "npm ci --ignore-scripts --no-audit --no-fund" })
  } else if (manifests.has("package.json")) {
    adapters.push({ name: "npm", command: "npm install --ignore-scripts --no-audit --no-fund --package-lock=false" })
  }
  if (manifests.has("uv.lock")) {
    adapters.push({ name: "uv", command: "uv sync --frozen --no-install-project --no-dev" })
  } else if (manifests.has("poetry.lock")) {
    adapters.push({ name: "poetry", command: "poetry install --no-root --no-interaction --no-ansi" })
  } else if (manifests.has("requirements.txt")) {
    adapters.push({
      name: "pip",
      command:
        "python3 -m venv .venv && .venv/bin/python -m pip install --disable-pip-version-check --no-input -r requirements.txt",
    })
  }
  if (manifests.has("go.mod")) {
    adapters.push({
      name: "go",
      command: "mkdir -p .cyberful-cache/go && GOMODCACHE=/workspace/.cyberful-cache/go go mod download",
      environment: { GOMODCACHE: "/workspace/.cyberful-cache/go" },
    })
  }
  if (manifests.has("Cargo.toml")) {
    adapters.push({
      name: "cargo",
      command: "mkdir -p .cyberful-cache/cargo && CARGO_HOME=/workspace/.cyberful-cache/cargo cargo fetch --locked",
      environment: { CARGO_HOME: "/workspace/.cyberful-cache/cargo" },
    })
  }
  if (manifests.has("composer.json")) {
    adapters.push({
      name: "composer",
      command:
        "mkdir -p .cyberful-cache/composer && COMPOSER_HOME=/workspace/.cyberful-cache/composer composer install --no-interaction --no-progress --no-scripts --no-plugins",
      environment: { COMPOSER_HOME: "/workspace/.cyberful-cache/composer" },
    })
  }
  if (manifests.has("Gemfile")) {
    adapters.push({
      name: "bundler",
      command: "mkdir -p .cyberful-cache/bundle && BUNDLE_PATH=/workspace/.cyberful-cache/bundle bundle install",
      environment: { BUNDLE_PATH: "/workspace/.cyberful-cache/bundle" },
    })
  }
  if (manifests.has("pom.xml")) {
    adapters.push({
      name: "maven",
      command: "mkdir -p .cyberful-cache/m2 && mvn -B -Dmaven.repo.local=/workspace/.cyberful-cache/m2 dependency:go-offline",
      environment: { MAVEN_OPTS: "-Dmaven.repo.local=/workspace/.cyberful-cache/m2" },
    })
  }
  return adapters
}

async function bootstrap(labRoot: string, adapter: BootstrapAdapter, phase: string) {
  const image = process.env.CYBERFUL_OS_IMAGE?.trim() || "cyberful-os:latest"
  const name = `cyberful-audit-bootstrap-${phase}-${randomUUID().slice(0, 12)}`
  const args = [
    "run",
    "--rm",
    "--pull=never",
    "--name",
    name,
    "--hostname",
    name,
    "--cpus=2",
    "--memory=4g",
    "--pids-limit=512",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=512m",
    "--tmpfs",
    "/root:rw,nosuid,size=512m",
    "-v",
    `${labRoot}:/workspace`,
    "-w",
    "/workspace",
    "-e",
    "CI=1",
    "-e",
    "DO_NOT_TRACK=1",
    "-e",
    "NO_COLOR=1",
    "-e",
    "NPM_CONFIG_AUDIT=false",
    "-e",
    "NPM_CONFIG_FUND=false",
    "-e",
    "NPM_CONFIG_UPDATE_NOTIFIER=false",
    "-e",
    "PIP_DISABLE_PIP_VERSION_CHECK=1",
    image,
    "bash",
    "-lc",
    adapter.command,
  ]
  const result = await docker(args)
  if (result.timedOut) {
    const cleanup = await docker(["rm", "-f", name])
    if (cleanup.exitCode !== 0 && !cleanup.stderr.includes("No such container"))
      throw new Error(`timed-out dependency bootstrap could not be destroyed: ${cleanup.stderr.trim()}`)
  }
  const redact = (value: string) =>
    value
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@")
      .replace(/([?&](?:access_token|api_key|apikey|auth|key|password|secret|token)=)[^&\s]+/gi, "$1[redacted]")
  return {
    adapter: adapter.name,
    command: adapter.command,
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    output_truncated: result.truncated,
    stdout: redact(result.stdout).slice(0, 64 * 1024),
    stderr: redact(result.stderr).slice(0, 64 * 1024),
    environment: adapter.environment ?? {},
  }
}

export function auditLabAvailable() {
  const root = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim()
  return Boolean(root && path.isAbsolute(root))
}

async function prepareAuditLabOnce(args: Record<string, unknown>) {
  const workflow = process.env.CYBERFUL_SUBSYSTEM_WORKFLOW?.trim()
  const phase = process.env.CYBERFUL_SUBSYSTEM_PHASE?.trim()
  if (workflow !== "code-audit" || (phase !== "attack" && phase !== "verify"))
    throw new Error("audit lab is available only during Code Audit Attack and Verify")
  const configuredWorkarea = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim()
  if (!configuredWorkarea || !path.isAbsolute(configuredWorkarea)) throw new Error("audit lab workarea is unavailable")
  const workarea = await realpath(configuredWorkarea)
  const prefix = requestedPath(args.path)
  const phaseRoot = path.join(workarea, LAB_ROOT, phase)
  if (!isContained(workarea, phaseRoot)) throw new Error("audit lab root escapes workarea")
  await plainDirectory(workarea, LAB_ROOT)
  await rm(phaseRoot, { recursive: true, force: true })
  await mkdir(phaseRoot, { mode: 0o700 })
  activeLabs.add(phaseRoot)

  const manifests = await materializeSourceForAuditLab(phaseRoot, prefix, { manifestsOnly: true })
  const adapters = args.bootstrap === "none" ? [] : bootstrapAdapters(manifests.files)
  const bootstrapResults = []
  for (const adapter of adapters) bootstrapResults.push(await bootstrap(phaseRoot, adapter, phase))
  const source = await materializeSourceForAuditLab(phaseRoot, prefix)
  const runtimeEnvironment = Object.assign({}, ...adapters.map((adapter) => adapter.environment ?? {}))
  const relativeLabPath = `${LAB_ROOT}/${phase}`
  const record = {
    version: 1,
    phase,
    source_prefix: source.source_prefix,
    source_kind: source.source_kind,
    source_sha256: source.sha256,
    source_files: source.file_count,
    manifest_sha256: manifests.sha256,
    bootstrap_mode: args.bootstrap === "none" ? "none" : "auto",
    bootstrap: bootstrapResults,
    runtime_environment: runtimeEnvironment,
    lab_path: relativeLabPath,
    container_path: `/workspace/${relativeLabPath}`,
    isolation: {
      checkout_mutated: false,
      source_visible_during_network: false,
      host_credentials_mounted: false,
      runtime_network: "none",
      bootstrap_container_destroyed: true,
      cpu_limit: 2,
      memory_limit: "4g",
      pids_limit: 512,
    },
    created_at: new Date().toISOString(),
  }
  const evidencePath = `raw/code-audit/${phase}/lab.json`
  await replaceWorkareaFile(workarea, evidencePath, JSON.stringify(record, null, 2) + "\n")
  return { ...record, evidence_path: evidencePath }
}

export function prepareAuditLab(args: Record<string, unknown>) {
  const result = preparationTail.then(
    () => prepareAuditLabOnce(args),
    () => prepareAuditLabOnce(args),
  )
  preparationTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export async function cleanupAuditLabs() {
  await preparationTail
  const labs = [...activeLabs]
  const results = await Promise.allSettled(labs.map((lab) => rm(lab, { recursive: true, force: true })))
  for (const [index, result] of results.entries()) {
    const lab = labs[index]
    if (result.status === "fulfilled" && lab) activeLabs.delete(lab)
  }
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), "audit lab cleanup failed")
}
