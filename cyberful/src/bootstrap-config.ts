// ── Embedded First-Party Asset Bootstrap ─────────────────────────
// Materializes release-bundled policy, cyberful-os, and ZAP assets while keeping
// source runs and explicit operator locations on their native filesystem paths.
// → cyberful/builtin/cyberful.json — anchors the first-party configuration tree.
// → cyberful/src/index.ts — evaluates this bootstrap before command handlers start.
// ─────────────────────────────────────────────────────────────────
import fs from "node:fs"
import path from "node:path"
import { Global } from "@/global"
import * as Builtin from "./builtin"

// Build `define`s inject these as object literals (JSON.stringify → `{...}`), like CYBERFUL_MIGRATIONS —
// used directly, NOT JSON.parse'd. Undefined in dev/source mode.
declare const CYBERFUL_EMBEDDED_CONFIG: Record<string, string> | undefined
declare const CYBERFUL_EMBEDDED_CYBERFUL_OS: Record<string, string> | undefined
declare const CYBERFUL_EMBEDDED_ZAP: Record<string, string> | undefined
declare const CYBERFUL_BUILD_ID: string | undefined

function buildIdSlug(): string {
  const buildID = typeof CYBERFUL_BUILD_ID === "string" && CYBERFUL_BUILD_ID ? CYBERFUL_BUILD_ID : "embedded"
  return buildID.replace(/[^a-zA-Z0-9._-]/g, "-")
}

// ── One Materialized Tree Is One Release Contract ────────────────
// Build definitions contain complete trusted file maps, so a build-specific
// directory can be reused after its completion stamp exists. Executable assets
// recover their launch permission while ordinary policy files remain data. The
// environment is activated only after materialization succeeds, preventing
// command handlers from observing a partially selected first-party tree.
// ─────────────────────────────────────────────────────────────────
function materialize(dir: string, files: Record<string, string>, executableDir?: string) {
  const stamp = path.join(dir, ".materialized")
  if (fs.existsSync(stamp)) return
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
    if (executableDir && rel.replaceAll("\\", "/").startsWith(`${executableDir}/`)) fs.chmodSync(target, 0o755)
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(stamp, buildIdSlug())
}

function activateConfigDir(configDir: string) {
  process.env.CYBERFUL_CONFIG_DIR = configDir
  if (process.env.CYBERFUL_DISABLE_PROJECT_CONFIG === undefined) process.env.CYBERFUL_DISABLE_PROJECT_CONFIG = "1"
}

function materializeEmbeddedConfig(): boolean {
  if (typeof CYBERFUL_EMBEDDED_CONFIG === "undefined") return false
  const files = CYBERFUL_EMBEDDED_CONFIG
  if (!files || Object.keys(files).length === 0) return false
  if (process.env.CYBERFUL_CONFIG_DIR) return false

  const configDir = path.join(Global.Path.cache, `config-${buildIdSlug()}`, "builtin")
  materialize(configDir, files)
  activateConfigDir(configDir)
  return true
}

function activateSourceConfig(): boolean {
  if (typeof CYBERFUL_EMBEDDED_CONFIG !== "undefined") return false
  if (process.env.CYBERFUL_CONFIG_DIR) return false
  if (!fs.existsSync(path.join(Builtin.DIR, "cyberful.json"))) return false
  activateConfigDir(Builtin.DIR)
  return true
}

function materializeEmbeddedCyberfulOs(): boolean {
  if (typeof CYBERFUL_EMBEDDED_CYBERFUL_OS === "undefined") return false
  const files = CYBERFUL_EMBEDDED_CYBERFUL_OS
  if (!files || Object.keys(files).length === 0) return false
  if (process.env.CYBERFUL_OS_DIR) return false

  const cyberfulOsDir = path.join(Global.Path.cache, `cyberful-os-${buildIdSlug()}`)
  materialize(cyberfulOsDir, files, "bin")

  process.env.CYBERFUL_OS_DIR = cyberfulOsDir
  return true
}

function materializeEmbeddedZap(): boolean {
  if (typeof CYBERFUL_EMBEDDED_ZAP === "undefined") return false
  const files = CYBERFUL_EMBEDDED_ZAP
  if (!files || Object.keys(files).length === 0 || process.env.CYBER_ZAP_DIR) return false

  const zapDir = path.join(Global.Path.cache, `zap-${buildIdSlug()}`)
  materialize(zapDir, files)
  process.env.CYBER_ZAP_DIR = zapDir
  return true
}

// Run config and cyberful-os bootstraps independently so a build carrying only one asset still initializes it.
const configReady = materializeEmbeddedConfig() || activateSourceConfig()
const cyberfulOsReady = materializeEmbeddedCyberfulOs()
const zapReady = materializeEmbeddedZap()
export const bootstrapConfigReady = configReady || cyberfulOsReady || zapReady
