// ── Embedded Browser Bootstrap ───────────────────────────────────
// Materializes the pinned agent-browser executable and version-matched skills,
// then binds source and installed builds to five target identities plus search.
// → cyberful/src/dependency/browser-preflight.ts — verifies agent-browser and Chrome.
// → mcps/browser/bin/cyber-browser — resolves source-checkout native binaries.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────
import fs from "node:fs"
import path from "node:path"
import { Global } from "@/global"
import { browserHome, browserProfileDir } from "@/dependency/browser-profile"

declare const CYBERFUL_EMBEDDED_BROWSER: Record<string, string> | undefined
declare const CYBERFUL_EMBEDDED_BROWSER_BIN: Record<string, string> | undefined
declare const CYBERFUL_BUILD_ID: string | undefined

function buildIdSlug(): string {
  const buildID = typeof CYBERFUL_BUILD_ID === "string" && CYBERFUL_BUILD_ID ? CYBERFUL_BUILD_ID : "embedded"
  return buildID.replace(/[^a-zA-Z0-9._-]/g, "-")
}

function agentBrowserBinaryName(): string {
  if (process.platform === "darwin")
    return process.arch === "arm64" ? "agent-browser-darwin-arm64" : "agent-browser-darwin-x64"
  if (process.platform === "win32") return "agent-browser-win32-x64.exe"
  const libc = process.env.CYBERFUL_LIBC === "musl" ? "linux-musl" : "linux"
  return process.arch === "arm64" ? `agent-browser-${libc}-arm64` : `agent-browser-${libc}-x64`
}

// ── Browser State Outlives A Release Cache ───────────────────────
// Driver files are immutable build assets and belong in a build-specific cache,
// but Chromium and the isolated profiles are large mutable user state. Keeping
// those resources in a stable browser home avoids downloading Chromium after
// every upgrade and preserves the dedicated Cyberful profiles. Explicit command
// and path overrides still win, so source runs and operator policy remain intact.
// ─────────────────────────────────────────────────────────────────
function materializeBrowser(): boolean {
  const text = typeof CYBERFUL_EMBEDDED_BROWSER === "undefined" ? undefined : CYBERFUL_EMBEDDED_BROWSER
  const bin = typeof CYBERFUL_EMBEDDED_BROWSER_BIN === "undefined" ? undefined : CYBERFUL_EMBEDDED_BROWSER_BIN
  const hasText = Boolean(text && Object.keys(text).length)
  const hasBin = Boolean(bin && Object.keys(bin).length)
  if (!hasText && !hasBin) return false
  // A power-user / dev override of the launcher command always wins.
  if (process.env.CYBER_BROWSER_MCP_COMMAND || process.env.CYBER_BROWSER_MCP || process.env.CYBER_AGENT_BROWSER_BINARY)
    return false

  const root = path.join(Global.Path.cache, `browser-${buildIdSlug()}`)
  const stamp = path.join(root, ".materialized")
  if (!fs.existsSync(stamp)) {
    for (const [rel, content] of Object.entries(text ?? {})) {
      const target = path.join(root, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
    for (const [rel, b64] of Object.entries(bin ?? {})) {
      const target = path.join(root, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, Buffer.from(b64, "base64"))
    }
    // Compatibility launchers and the selected native executable keep +x.
    const binDir = path.join(root, "browser", "bin")
    if (fs.existsSync(binDir)) {
      for (const f of fs.readdirSync(binDir)) fs.chmodSync(path.join(binDir, f), 0o755)
    }
    const agentBinary = path.join(root, "node_modules", "agent-browser", "bin", agentBrowserBinaryName())
    if (fs.existsSync(agentBinary) && process.platform !== "win32") fs.chmodSync(agentBinary, 0o755)
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(stamp, buildIdSlug())
  }

  const agentBinary = path.join(root, "node_modules", "agent-browser", "bin", agentBrowserBinaryName())
  if (!fs.existsSync(agentBinary)) throw new Error(`embedded agent-browser binary is missing: ${agentBinary}`)
  process.env.CYBER_BROWSER_MCP_COMMAND = agentBinary
  process.env.CYBER_AGENT_BROWSER_BINARY = agentBinary
  process.env.CYBER_BROWSER_AGENT_NATIVE = "1"
  const captchaPlugin = path.join(
    root,
    "browser",
    "bin",
    `agent-browser-plugin-captcha${process.platform === "win32" ? ".exe" : ""}`,
  )
  if (!fs.existsSync(captchaPlugin)) throw new Error(`embedded CAPTCHA plugin is missing: ${captchaPlugin}`)
  process.env.CYBER_BROWSER_CAPTCHA_PLUGIN_COMMAND = captchaPlugin
  delete process.env.CYBER_BROWSER_MCP_ENTRY
  process.env.CYBER_BROWSER_PACKAGE_ROOT = root
  return true
}

// ── Source And Release Launches Share Browser State ─────────────────
// The embedded payload exists only in release binaries, but manual profile
// seeding is a source-tree command. Both launch paths must resolve the same
// Chromium cache and first persistent identity or a successful pre-login would
// disappear when Cyberful starts. Environment overrides remain authoritative,
// including the numbered profile-one override used by the browser profile router.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────────
if (!process.env.CYBER_BROWSER_USER_DATA_DIR && !process.env.CYBER_BROWSER_USER_DATA_DIR_1) {
  process.env.CYBER_BROWSER_USER_DATA_DIR = browserProfileDir(1)
}

export const bootstrapBrowserReady = materializeBrowser()

export { browserHome }

export * as BootstrapBrowser from "./bootstrap-browser"
