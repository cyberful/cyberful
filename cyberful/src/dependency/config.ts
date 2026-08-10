// ── Runtime Dependency Policy ────────────────────────────────────
// Resolves validated environment policy, executable locations, container
// commands, and immutable runtime identity for Cyberful's external services.
// → cyberful/src/subsystem/engagement-runtime.ts — starts the selected unified image.
// → cyberful/src/subsystem/phase-runner.ts — consumes the resolved phase policy.
// @docs/getting-started/requirements.md
// ─────────────────────────────────────────────────────────────────

import fs from "node:fs"
import path from "node:path"

declare const CYBERFUL_RUNTIME_FINGERPRINT: string | undefined

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

  const engagementContainer = envValue("CYBERFUL_OS_CONTAINER")
  const requireEngagementContainer = envValue("CYBERFUL_OS_REQUIRE_ENGAGEMENT_CONTAINER")
  if (engagementContainer && requireEngagementContainer && !disabled("CYBERFUL_OS_REQUIRE_ENGAGEMENT_CONTAINER")) {
    return [
      "docker",
      "exec",
      "-i",
      "-w",
      "/workspace",
      "-e",
      "CYBERFUL_OS_IN_CONTAINER=1",
      "-e",
      "CYBERFUL_OS_MOUNT=/workspace",
      "-e",
      "CYBERFUL_SUBSYSTEM_WORKAREA_ROOT=/workspace",
      "-e",
      "CYBERFUL_OS_HTTP_PROXY",
      "-e",
      "CYBERFUL_OS_CA_BUNDLE",
      engagementContainer,
      "/opt/cyberful-os-venv/bin/python",
      "/opt/cyberful-os/cyberful_os_mcp.py",
    ]
  }

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
  if (configured) {
    const entry = envValue("CYBER_BROWSER_MCP_ENTRY")
    return entry ? [configured, entry] : [configured]
  }
  const dir = cyberBrowserMcpDir()
  if (dir) return [path.join(dir, "bin/cyber-browser")]
  return ["cyber-browser"]
}

export function shouldEnableCyberZap() {
  return !disabled("CYBER_ZAP_ENABLED")
}

export function cyberZapProxyPort() {
  return envInt("CYBER_ZAP_PROXY_PORT", 0, { minimum: 0, maximum: 65_535 })
}

export function cyberZapStartupTimeoutSeconds() {
  return envInt("CYBER_ZAP_STARTUP_TIMEOUT_SECONDS", 120, { minimum: 1, maximum: 3_600 })
}

export function shouldEnableCyberGhidra() {
  return !disabled("CYBER_GHIDRA_ENABLED")
}

export function cyberGhidraStartupTimeoutSeconds() {
  return envInt("CYBER_GHIDRA_STARTUP_TIMEOUT_SECONDS", 300, { minimum: 30, maximum: 3_600 })
}

// ── Protocol Bridges Execute Inside The Engagement Runtime ──────
// ZAP and Ghidra listeners remain loopback-only inside their engagement role.
// A phase gateway uses docker exec for a fresh stdio process, forwarding only
// the selected service credential. ZAP resolves its host-owned dedicated role;
// Ghidra resolves the core role. Closing stdio reaps only that bridge process.
// ─────────────────────────────────────────────────────────────────
export function cyberGhidraBridgeCommand(container = envValue("CYBERFUL_OS_CONTAINER")) {
  if (!container) return []
  return [
    "docker",
    "exec",
    "-i",
    "-e",
    "CYBER_GHIDRA_MCP_KEY",
    container,
    "/opt/cyberful-os-venv/bin/python",
    "/opt/cyberful/ghidra/ghidra_bridge.py",
  ]
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

export function cyberZapBridgeCommand(
  container = envValue("CYBERFUL_ZAP_RUNTIME_CONTAINER") ?? envValue("CYBERFUL_OS_CONTAINER"),
) {
  if (!container) return []
  return [
    "docker",
    "exec",
    "-i",
    "-e",
    "CYBER_ZAP_MCP_KEY",
    "-e",
    "CYBER_ZAP_API_KEY",
    "-e",
    "CYBER_ZAP_WORKAREA=/zap/wrk",
    container,
    "node",
    "/opt/cyberful/zap/zap_bridge.mjs",
  ]
}

export function cyberfulOsContainerCommand() {
  const configured = envValue("CYBERFUL_OS_CONTAINER_COMMAND")
  if (configured) return [configured]

  const root = cyberfulOsDir()
  if (root) return [cyberfulOsBinaryPath(root, "cyberful-os-container")]

  return ["cyberful-os-container"]
}

export function cyberfulOsBuildCommand(image = cyberfulOsImage()) {
  const configured = envValue("CYBERFUL_OS_BUILD_COMMAND")
  if (configured) return [configured]

  const root = cyberfulOsDir()
  if (root)
    return [
      "docker",
      "build",
      "--progress=plain",
      "--tag",
      image,
      "--file",
      path.join(root, "Dockerfile"),
      path.dirname(root),
    ]

  return ["cyberful-os-build"]
}

export function cyberfulOsImage() {
  const fingerprint = cyberfulOsRuntimeFingerprint()
  return envValue("CYBERFUL_OS_IMAGE") ?? (fingerprint ? `cyberful-os:runtime-${fingerprint}` : "cyberful-os:latest")
}

export function cyberfulOsRuntimeFingerprint() {
  const embedded = typeof CYBERFUL_RUNTIME_FINGERPRINT === "string" ? CYBERFUL_RUNTIME_FINGERPRINT.trim() : ""
  return /^[a-f0-9]{64}$/.test(embedded) ? embedded : undefined
}

export function cyberfulOsImageIsManaged() {
  return !envValue("CYBERFUL_OS_IMAGE") && Boolean(cyberfulOsRuntimeFingerprint())
}

const DEPRECATED_RUNTIME_ENV = [
  "CYBERFUL_OS_AUTOSTART",
  "CYBER_ZAP_DIR",
  "CYBER_ZAP_IMAGE",
  "CYBER_ZAP_BRIDGE_IMAGE",
  "CYBER_ZAP_CONTAINER",
  "CYBER_GHIDRA_DIR",
  "CYBER_GHIDRA_IMAGE",
  "CYBER_GHIDRA_BRIDGE_IMAGE",
  "CYBER_GHIDRA_CONTAINER",
] as const

export function validateUnifiedRuntimeEnvironment() {
  const configured = DEPRECATED_RUNTIME_ENV.filter((name) => process.env[name]?.trim())
  if (configured.length === 0) return
  throw new Error(
    `Separate runtime configuration is no longer supported (${configured.join(", ")}). ` +
      "Use CYBERFUL_OS_IMAGE to override the unified cyberful-os image.",
  )
}

// ── Pi Is The Immutable Agent Subsystem ──────────────────────────
// Every autonomous phase is executed through Pi. Provider and model selection
// live exclusively in settings.yaml; this marker is journal provenance rather
// than an alternate runtime selector. Keeping that identity immutable also
// prevents environment input from opening a second execution path.
// ─────────────────────────────────────────────────────────────────

export type ExpertBackend = "pi"

export interface ExpertRuntime {
  backend: ExpertBackend
}

export const EXPERT_SESSION_SUBSYSTEM_ID = "pi-agent"

export function expertSessionModel() {
  return { subsystemID: EXPERT_SESSION_SUBSYSTEM_ID, modelID: "configured-provider" }
}

export function isExpertSessionModel(model: { subsystemID: string; modelID?: string } | undefined) {
  return model?.subsystemID === EXPERT_SESSION_SUBSYSTEM_ID
}

export function expertRuntime(): ExpertRuntime {
  return { backend: "pi" }
}

export * as DependencyConfig from "./config"
