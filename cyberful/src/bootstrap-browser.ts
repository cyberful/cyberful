// ── Embedded Browser Bootstrap ───────────────────────────────────
// Materializes the browser MCP and its binary assets from release definitions,
// then binds source and installed builds to five stable profile identities.
// → cyberful/src/dependency/browser-preflight.ts — acquires Chromium separately on first use.
// → mcps/browser/bin/cyber-browser — consumes the materialized driver layout.
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
  return true
}

// ── Source And Release Launches Share Browser State ─────────────────
// The embedded payload exists only in release binaries, but manual profile
// seeding is a source-tree command. Both launch paths must resolve the same
// Chromium cache and first persistent identity or a successful pre-login would
// disappear when Cyberful starts. Environment overrides remain authoritative,
// including the numbered profile-one override used by the five-profile router.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────────
const home = browserHome()
if (!process.env.CYBER_BROWSER_BROWSERS_PATH) process.env.CYBER_BROWSER_BROWSERS_PATH = path.join(home, ".browsers")
if (!process.env.CYBER_BROWSER_USER_DATA_DIR && !process.env.CYBER_BROWSER_USER_DATA_DIR_1) {
  process.env.CYBER_BROWSER_USER_DATA_DIR = browserProfileDir(1)
}

export const bootstrapBrowserReady = materializeBrowser()

export { browserHome }

export * as BootstrapBrowser from "./bootstrap-browser"
