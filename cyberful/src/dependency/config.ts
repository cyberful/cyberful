// ── Runtime Dependency Policy ────────────────────────────────────
// Resolves validated environment policy, executable locations, container
// commands, and immutable Codex identity for Cyberful's external runtimes.
// → cyberful/src/dependency/startup.ts — starts dependencies from this canonical policy.
// → cyberful/src/subsystem/codex.ts — consumes the resolved Codex phase policy.
// @docs/getting-started/requirements.md
// ─────────────────────────────────────────────────────────────────

import fs from "node:fs"
import path from "node:path"

const SIBLING_CYBERFUL_OS_DIR = "../../../cyberful-os"
const SIBLING_MCPS_DIR = "../../../mcps"

function existingDir(dir: string | undefined) {
  if (!dir) return
  return fs.existsSync(dir) ? dir : undefined
}

function existingFile(file: string | undefined) {
  if (!file) return
  return fs.existsSync(file) ? file : undefined
}

function envPath(name: string) {
  const value = process.env[name]?.trim()
  if (!value) return
  return path.resolve(value)
}

function envValue(name: string) {
  const value = process.env[name]?.trim()
  if (!value) return
  return value
}

function envInt(name: string, fallback: number, options: { minimum: number; maximum: number }) {
  const source = process.env[name]?.trim()
  if (source === undefined) return fallback
  if (!/^\d+$/.test(source)) throw new Error(`${name} must be a decimal integer`)
  const value = Number(source)
  if (!Number.isSafeInteger(value) || value < options.minimum || value > options.maximum) {
    throw new RangeError(`${name} must be between ${options.minimum} and ${options.maximum}`)
  }
  return value
}

function disabled(name: string) {
  const value = process.env[name]?.trim().toLowerCase()
  if (value === undefined) return false
  if (value === "0" || value === "false" || value === "no") return true
  if (value === "1" || value === "true" || value === "yes") return false
  throw new Error(`${name} must be one of: 1, true, yes, 0, false, no`)
}

export function cyberfulOsDir() {
  return (
    envPath("CYBERFUL_OS_DIR") ??
    existingDir(path.resolve(import.meta.dirname, SIBLING_CYBERFUL_OS_DIR)) ??
    existingDir(path.resolve(import.meta.dirname, SIBLING_MCPS_DIR, "cyberful-os"))
  )
}

export function shouldStartCyberfulOs() {
  return Boolean(cyberfulOsDir()) && !disabled("CYBERFUL_OS_AUTOSTART")
}

export function shouldEnableCyberfulOsMcp() {
  return Boolean(cyberfulOsDir()) && !disabled("CYBERFUL_OS_MCP_ENABLED")
}

// ── One Resolver Supports Both cyberful-os Layouts ──────────────────
// The in-repository distribution stores launchers directly under bin, while an
// external cyberful-os checkout nests them below mcp/cyberful-os/bin. Dependency
// discovery selects the first proven file under the already resolved root.
// Keeping this compatibility decision here prevents callers from guessing the
// active distribution layout or constructing divergent executable paths.
// ─────────────────────────────────────────────────────────────────
function cyberfulOsBinaryPath(root: string, name: string) {
  return existingFile(path.join(root, "bin", name)) ?? path.join(root, "mcp/cyberful-os/bin", name)
}

export function cyberfulOsMcpCommand() {
  const configured = envValue("CYBERFUL_OS_MCP_COMMAND") ?? envValue("CYBERFUL_OS_MCP")
  if (configured) return [configured]

  const root = cyberfulOsDir()
  if (root) return [cyberfulOsBinaryPath(root, "cyberful-os")]

  return ["cyberful-os"]
}

export function cyberBrowserMcpDir() {
  const root = cyberfulOsDir()
  const mcpsRoot = existingDir(path.resolve(import.meta.dirname, SIBLING_MCPS_DIR))
  return (
    existingDir(root ? path.join(root, "mcp/browser") : undefined) ??
    existingDir(mcpsRoot ? path.join(mcpsRoot, "browser") : undefined)
  )
}

export function shouldEnableCyberBrowserMcp() {
  return (
    Boolean(cyberBrowserMcpDir() ?? envValue("CYBER_BROWSER_MCP_COMMAND") ?? envValue("CYBER_BROWSER_MCP")) &&
    !disabled("CYBER_BROWSER_MCP_ENABLED")
  )
}

export function cyberBrowserMcpCommand() {
  const configured = envValue("CYBER_BROWSER_MCP_COMMAND") ?? envValue("CYBER_BROWSER_MCP")
  if (configured) return [configured]
  const dir = cyberBrowserMcpDir()
  if (dir) return [path.join(dir, "bin/cyber-browser")]
  return ["cyber-browser"]
}

export function cyberZapDir() {
  return envPath("CYBER_ZAP_DIR") ?? existingDir(path.resolve(import.meta.dirname, SIBLING_MCPS_DIR, "zap"))
}

export function shouldEnableCyberZap() {
  return !disabled("CYBER_ZAP_ENABLED")
}

export function cyberZapImage() {
  return envValue("CYBER_ZAP_IMAGE") ?? "cyberful-zap:2.17.0"
}

export function cyberZapBridgeImage() {
  return envValue("CYBER_ZAP_BRIDGE_IMAGE") ?? "cyberful-zap-bridge:0.1.0"
}

export function cyberZapProxyPort() {
  return envInt("CYBER_ZAP_PROXY_PORT", 0, { minimum: 0, maximum: 65_535 })
}

export function cyberZapStartupTimeoutSeconds() {
  return envInt("CYBER_ZAP_STARTUP_TIMEOUT_SECONDS", 120, { minimum: 1, maximum: 3_600 })
}

export function cyberZapBuildCommand() {
  const dir = cyberZapDir()
  return dir ? ["docker", "build", "--tag", cyberZapImage(), "--file", path.join(dir, "Dockerfile"), dir] : []
}

export function cyberZapBridgeBuildCommand() {
  const dir = cyberZapDir()
  return dir
    ? ["docker", "build", "--tag", cyberZapBridgeImage(), "--file", path.join(dir, "Dockerfile.bridge"), dir]
    : []
}

export function shouldChainBrowserThroughZap() {
  return shouldEnableCyberBrowserMcp() && shouldEnableCyberZap() && !disabled("CYBER_BROWSER_THROUGH_ZAP")
}

export function cyberBrowserZapChainEnv():
  | {
      CYBER_BROWSER_PROXY: string
      CYBER_BROWSER_PROXY_CA_SPKI: string
    }
  | undefined {
  const proxy = envValue("CYBER_ZAP_PROXY_URL")
  const spki = envValue("CYBER_BROWSER_PROXY_CA_SPKI")
  if (!proxy || !spki) return
  return { CYBER_BROWSER_PROXY: proxy, CYBER_BROWSER_PROXY_CA_SPKI: spki }
}

// ── ZAP Bridges Preserve The Session Trust Boundary ──────────────
// Each phase receives an ephemeral bridge in the session ZAP container's
// network namespace, leaving the MCP port reachable only through loopback.
// The bridge mounts the authorized engagement workarea for large artifacts and
// receives secret names through the environment rather than command arguments.
// Labels bind cleanup to the owning process and session without broadening the
// target or filesystem scope granted to the phase.
// ─────────────────────────────────────────────────────────────────
function dockerIdentifier(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(-36)
}

export function cyberZapBridgeContainerName() {
  const container = envValue("CYBER_ZAP_CONTAINER")
  if (!container) return
  return `cyberful-zap-bridge-${dockerIdentifier(envValue("CYBERFUL_SUBSYSTEM_SESSION") ?? container)}-${process.pid}`
}

export function cyberZapBridgeCommand(
  workarea?: string,
  options?: { container?: string; name?: string; session?: string; ownerPID?: number },
) {
  const container = options?.container ?? envValue("CYBER_ZAP_CONTAINER")
  if (!container) return []
  const session = dockerIdentifier(options?.session ?? envValue("CYBERFUL_SUBSYSTEM_SESSION") ?? container)
  const name = options?.name ?? `cyberful-zap-bridge-${session}-${options?.ownerPID ?? process.pid}`
  return [
    "docker",
    "run",
    "--rm",
    "-i",
    "--pull=never",
    "--name",
    name,
    "--label",
    "org.cyberful.managed=zap-bridge",
    "--label",
    `org.cyberful.session=${session}`,
    "--label",
    `org.cyberful.owner-pid=${options?.ownerPID ?? process.pid}`,
    "--label",
    `org.cyberful.zap-container=${container}`,
    "--network",
    `container:${container}`,
    "--mount",
    `type=bind,source=${path.resolve(workarea ?? envPath("CYBER_ZAP_WORKAREA") ?? process.cwd())},target=/zap/wrk`,
    "--env",
    "CYBER_ZAP_MCP_KEY",
    "--env",
    "CYBER_ZAP_API_KEY",
    "--env",
    "CYBER_ZAP_ALLOWED_ORIGINS",
    "--env",
    "CYBER_ZAP_WORKAREA=/zap/wrk",
    cyberZapBridgeImage(),
  ]
}

export function cyberfulOsContainerCommand() {
  const configured = envValue("CYBERFUL_OS_CONTAINER_COMMAND")
  if (configured) return [configured]

  const root = cyberfulOsDir()
  if (root) return [cyberfulOsBinaryPath(root, "cyberful-os-container")]

  return ["cyberful-os-container"]
}

export function cyberfulOsBuildCommand() {
  const configured = envValue("CYBERFUL_OS_BUILD_COMMAND")
  if (configured) return [configured]

  const root = cyberfulOsDir()
  if (root) return [cyberfulOsBinaryPath(root, "cyberful-os-build")]

  return ["cyberful-os-build"]
}

export function cyberfulOsImage() {
  return envValue("CYBERFUL_OS_IMAGE") ?? "cyberful-os:latest"
}

// ── Codex Is The Immutable Phase Executor ────────────────────────
// Every autonomous phase is executed by Codex. The backend and executable are
// constants rather than configuration, so environment input may tune model
// policy but cannot select a second inference path. The backend literal remains
// in events and transcripts as provenance, never as a runtime selector. Session
// journal markers describe this executor without registering a second provider.
// ─────────────────────────────────────────────────────────────────

export type ExpertBackend = "codex"

export interface ExpertRuntime {
  backend: ExpertBackend
  command: string
  model?: string
}

export const EXPERT_SESSION_PROVIDER_ID = "codex-cli"

export function expertSessionModel() {
  return { providerID: EXPERT_SESSION_PROVIDER_ID, modelID: expertRuntime().model ?? "codex" }
}

export function isExpertSessionModel(model: { providerID: string; modelID?: string } | undefined) {
  return model?.providerID === EXPERT_SESSION_PROVIDER_ID
}

export function expertModel() {
  return envValue("CYBERFUL_SUBSYSTEM_MODEL") ?? "gpt-5.6-sol"
}

// ── Web Search Disablement Must Be Explicit ──────────────────────
// Codex enables cached search when its setting is omitted, so absence means the
// normal live-search policy rather than an indeterminate state. An explicit false
// value removes the tool entirely instead of merely disabling fresh results. The
// strict boolean parser rejects misspellings before they weaken that policy.
// ─────────────────────────────────────────────────────────────────
export function webSearchMode() {
  return disabled("WEB_SEARCH") ? "disabled" : "live"
}

export function expertRuntime(): ExpertRuntime {
  return {
    backend: "codex",
    command: "codex",
    model: expertModel(),
  }
}

// ── Phase Transcripts Preserve Execution Evidence ────────────────
// The session journal records phase state, while the raw stream transcript records
// how Codex reached its result. Persistence is therefore enabled by default and
// disabled only by an explicit false value. Buffered paths remain available when
// operators deliberately trade that execution evidence for reduced retention.
// ─────────────────────────────────────────────────────────────────
export function expertTranscriptEnabled() {
  return !disabled("CYBERFUL_SUBSYSTEM_TRANSCRIPT")
}

const DEFAULT_EXPERT_PHASE_TIMEOUT_SECONDS = 1800
export function expertPhaseTimeoutSeconds() {
  return envInt("CYBERFUL_SUBSYSTEM_PHASE_TIMEOUT_SECONDS", DEFAULT_EXPERT_PHASE_TIMEOUT_SECONDS, {
    minimum: 1,
    maximum: 86_400,
  })
}

export * as DependencyConfig from "./config"
