// ── Embedded Browser Bootstrap ───────────────────────────────────
// Materializes the browser MCP and its binary assets from release definitions,
// then points installed builds at the resulting per-build cache layout.
// → cyberful/src/dependency/browser-preflight.ts — acquires Chromium separately on first use.
// → mcps/browser/bin/cyber-browser — consumes the materialized driver layout.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Global } from "@/global"

declare const CYBERFUL_EMBEDDED_BROWSER: Record<string, string> | undefined
declare const CYBERFUL_EMBEDDED_BROWSER_BIN: Record<string, string> | undefined
declare const CYBERFUL_BUILD_ID: string | undefined

function buildIdSlug(): string {
  const buildID = typeof CYBERFUL_BUILD_ID === "string" && CYBERFUL_BUILD_ID ? CYBERFUL_BUILD_ID : "embedded"
  return buildID.replace(/[^a-zA-Z0-9._-]/g, "-")
}

// ── Browser State Outlives A Release Cache ───────────────────────
// Driver files are immutable build assets and belong in a build-specific cache,
// but Chromium and the isolated profile are large mutable user state. Keeping
// those resources in a stable browser home avoids downloading Chromium after
// every upgrade and preserves the dedicated Cyberful profile. Explicit command
// and path overrides still win, so source runs and operator policy remain intact.
// ─────────────────────────────────────────────────────────────────
export function browserHome(): string {
  return path.join(os.homedir(), ".cyberful", "browser")
}

function materializeBrowser(): boolean {
  const text = typeof CYBERFUL_EMBEDDED_BROWSER === "undefined" ? undefined : CYBERFUL_EMBEDDED_BROWSER
  const bin = typeof CYBERFUL_EMBEDDED_BROWSER_BIN === "undefined" ? undefined : CYBERFUL_EMBEDDED_BROWSER_BIN
  const hasText = Boolean(text && Object.keys(text).length)
  const hasBin = Boolean(bin && Object.keys(bin).length)
  if (!hasText && !hasBin) return false
  // A power-user / dev override of the launcher command always wins.
  if (process.env.CYBER_BROWSER_MCP_COMMAND || process.env.CYBER_BROWSER_MCP) return false

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
    // The launcher + installer scripts must keep their +x bit.
    const binDir = path.join(root, "browser", "bin")
    if (fs.existsSync(binDir)) {
      for (const f of fs.readdirSync(binDir)) fs.chmodSync(path.join(binDir, f), 0o755)
    }
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(stamp, buildIdSlug())
  }

  process.env.CYBER_BROWSER_MCP_COMMAND = path.join(root, "browser", "bin", "cyber-browser")
  // Chromium download + the cyberful profile live in the stable home, not the per-build cache.
  const home = browserHome()
  if (!process.env.CYBER_BROWSER_BROWSERS_PATH) process.env.CYBER_BROWSER_BROWSERS_PATH = path.join(home, ".browsers")
  if (!process.env.CYBER_BROWSER_USER_DATA_DIR) {
    process.env.CYBER_BROWSER_USER_DATA_DIR = path.join(home, "profiles", "cyberful")
  }
  return true
}

export const bootstrapBrowserReady = materializeBrowser()

export * as BootstrapBrowser from "./bootstrap-browser"
