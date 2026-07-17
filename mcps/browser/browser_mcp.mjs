#!/usr/bin/env node
// ── Isolated Browser MCP Server ─────────────────────────────────────
// Owns one engagement browser context, exposes bounded navigation and evidence
// tools over stdio MCP, and keeps protocol output separate from diagnostics.
// It validates tool input, constrains artifact reads, redacts network secrets,
// and closes its browser state on EOF or process shutdown.
// → mcps/browser/browser_context_ownership.mjs — protects shared CDP contexts during teardown.
// → mcps/browser/browser_download.mjs — confines and bounds downloaded artifacts.
// → mcps/browser/browser_launch_policy.mjs — defines background-network isolation.
// → mcps/browser/browser_origin_policy.mjs — confines opt-in engagement traffic by exact origin.
// ────────────────────────────────────────────────────────────────────

import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { releaseBrowserContext } from "./browser_context_ownership.mjs"
import { saveBrowserDownload } from "./browser_download.mjs"
import {
  BACKGROUND_NETWORKING_DISABLED_ARGS,
  PATCHRIGHT_DISABLED_FEATURES_ARG,
  prepareBackgroundNetworkingProfile,
} from "./browser_launch_policy.mjs"
import {
  browserOriginContextOptions,
  browserUrlAllowed,
  installBrowserOriginPolicy,
  parseBrowserAllowedOrigins,
} from "./browser_origin_policy.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SERVER_NAME = "browser"
const SERVER_VERSION = "0.1.0"
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000
const DEFAULT_MAX_TEXT_CHARS = 12_000
const DEFAULT_MAX_ELEMENTS = 80
const DEFAULT_NETWORK_LIMIT = 500
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
const MAX_ARTIFACT_SCAN_ENTRIES = 2048
const MAX_BATCH_REQUESTS = 32
const MAX_JSON_LINE_BYTES = 2 * 1024 * 1024
const MAX_JSON_DEPTH = 20
const MAX_JSON_ARRAY_ITEMS = 256
const MAX_JSON_OBJECT_PROPERTIES = 256
const MAX_JSON_STRING_CHARS = 1024 * 1024
const MAX_EVALUATE_OUTPUT_CHARS = 256 * 1024
const COOKIE_STORE_FILE_NAMES = new Set(["Cookies", "Cookies-journal", "Cookies-shm", "Cookies-wal"])
const COOKIE_SCAN_SKIP_DIRS = new Set([
  "Cache",
  "Code Cache",
  "Crashpad",
  "DawnCache",
  "GPUCache",
  "GrShaderCache",
  "IndexedDB",
  "Local Storage",
  "Service Worker",
  "Session Storage",
  "ShaderCache",
  "blob_storage",
])

// ── Browser State Stays Outside The User Profile ─────────────────────
// The MCP browser is allowed to persist artifacts and profile data, but those
// defaults live under the repo or XDG state tree instead of the user's normal
// Chrome profile. This prevents automation from inheriting personal sessions
// or profile locks; environment overrides keep the isolation boundary explicit.
// ─────────────────────────────────────────────────────────────────────

const ROOT = __dirname
const STATE_HOME = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
const BROWSERS_PATH = process.env.CYBER_BROWSER_BROWSERS_PATH || path.join(ROOT, ".browsers")
const USER_DATA_DIR =
  process.env.CYBER_BROWSER_USER_DATA_DIR || path.join(STATE_HOME, "cyberful-os", "mcp", "browser", "profile")
const ARTIFACTS_DIR =
  process.env.CYBER_BROWSER_ARTIFACTS_DIR || path.join(STATE_HOME, "cyberful-os", "mcp", "browser", "artifacts")
const ALLOWED_ORIGINS = parseBrowserAllowedOrigins(process.env.CYBER_BROWSER_ALLOWED_ORIGINS)

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH
}

let playwrightModule = null
let loadedDriverName = null
let context = null
let contextOwnership = "none"
let originPolicyFailure = null
let activePage = null
let cachedExecutablePath = null
const attachedPages = new WeakSet()

// ── Shared Browser Modes Preserve Tab Ownership ──────────────────────
// OWN_TAB scouts share one Chromium context but pin a private page instead of
// following sibling page events. Its CDP target id is stable across processes,
// unlike Playwright's connection-local page guid. EAGER owns no page at all: it
// launches the shared profile, publishes readiness, and parks until shutdown.
// These modes prevent one scout or hub from observing another scout's tab state.
// ─────────────────────────────────────────────────────────────────────

const OWN_TAB = envBool("CYBER_BROWSER_OWN_TAB", false)
const EAGER = envBool("CYBER_BROWSER_EAGER", false)
const CDP_ENDPOINT = (process.env.CYBER_BROWSER_CDP_ENDPOINT || "").trim()
let pinnedPage = null
let pinnedTargetId = null
const requestIds = new WeakMap()
const requestEntries = new WeakMap()
const responseById = new Map()
const refSelectors = new Map()
const networkLog = []
let networkSequence = 0
let downloadQueue = Promise.resolve()
const sharedBrowserAttestation = readSharedBrowserAttestation()
let proxyStatus = sharedBrowserAttestation?.proxy ?? {
  configured: Boolean(process.env.CYBER_BROWSER_PROXY),
  mode: process.env.CYBER_BROWSER_PROXY ? "pending" : "direct",
  warning:
    CDP_ENDPOINT && process.env.CYBER_BROWSER_PROXY
      ? "Shared browser proxy attestation is unavailable; proxy routing cannot be proven"
      : process.env.CYBER_BROWSER_PROXY_WARNING || null,
}
let browserRuntime = sharedBrowserAttestation
  ? { ...sharedBrowserAttestation.runtime, connection: "cdp-attached" }
  : {
      requested_channel: (process.env.CYBER_BROWSER_CHANNEL || "chromium").trim().toLowerCase(),
      resolved_channel: null,
      executable_path: process.env.CYBER_BROWSER_EXECUTABLE || null,
      version: null,
      driver: null,
      connection: CDP_ENDPOINT ? "cdp-attached" : "not-launched",
    }
let startupCookieCleanup = {
  done: false,
  enabled: envBool("CYBER_BROWSER_CLEAR_COOKIES_ON_START", false),
  removed_files: 0,
  context_cleared: false,
}

function eprint(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function ok(id, result) {
  send({ jsonrpc: "2.0", id, result })
}

function err(id, code, message, data = undefined) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  send({ jsonrpc: "2.0", id, error })
}

function stripAnsi(value) {
  return String(value).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
}

function toolResult(text, isError = false) {
  return {
    content: [{ type: "text", text: stripAnsi(text) }],
    isError,
  }
}

function toolException(error) {
  return toolResult(`error: ${error.name || "Error"}: ${error.message || String(error)}\n`, true)
}

function browserErrorMessage(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function isClosedBrowserError(error) {
  return /(?:browser|context|page|session|target).*(?:closed|disconnected)|Target closed/i.test(
    browserErrorMessage(error),
  )
}

function reportBestEffortFailure(label, error, options = {}) {
  if (options.allowTimeout && isTimeoutError(error)) return
  if (options.allowClosed && isClosedBrowserError(error)) return
  eprint(`${label} failed: ${browserErrorMessage(error)}`)
}

async function bestEffortBrowserOperation(label, operation, fallback, options = {}) {
  try {
    return await operation()
  } catch (error) {
    reportBestEffortFailure(label, error, options)
    return fallback
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

export function envBool(name, defaultValue) {
  const value = process.env[name]
  if (value === undefined || value === "") return defaultValue
  const normalized = value.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  throw new Error(`${name} must be one of true, false, 1, 0, yes, no, on, or off`)
}

function envInt(name, defaultValue, minimum, maximum) {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return defaultValue
  const normalized = raw.trim()
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

// ── Shared Proxy State Requires Host Attestation ─────────────────────
// A CDP scout did not launch the shared browser and cannot infer its immutable
// proxy flags locally. Only the versioned readiness shape from the owning hub is
// accepted. Missing or malformed state leaves the proxy pending rather than
// claiming traffic passed through ZAP without evidence from the launch owner.
// ─────────────────────────────────────────────────────────────────────

function readSharedBrowserAttestation() {
  const raw = (process.env.CYBER_BROWSER_SHARED_ATTESTATION || "").trim()
  if (!raw) return null
  const invalid = (reason) => {
    eprint(`ignoring invalid CYBER_BROWSER_SHARED_ATTESTATION: ${reason}`)
    return null
  }
  try {
    const value = JSON.parse(raw)
    const proxy = value?.proxy
    const runtime = value?.runtime
    if (value?.version !== 1 || !proxy || !runtime) return invalid("unsupported or incomplete shape")
    if (typeof proxy.configured !== "boolean") return invalid("proxy.configured must be boolean")
    if (!["direct", "zap", "direct-fallback"].includes(proxy.mode)) return invalid("proxy.mode is unsupported")
    if (proxy.warning !== null && typeof proxy.warning !== "string")
      return invalid("proxy.warning must be string or null")
    for (const key of ["requested_channel", "resolved_channel", "executable_path", "version", "driver"]) {
      if (runtime[key] !== null && typeof runtime[key] !== "string") {
        return invalid(`runtime.${key} must be string or null`)
      }
    }
    return {
      version: 1,
      proxy: { configured: proxy.configured, mode: proxy.mode, warning: proxy.warning },
      runtime: {
        requested_channel: runtime.requested_channel,
        resolved_channel: runtime.resolved_channel,
        executable_path: runtime.executable_path,
        version: runtime.version,
        driver: runtime.driver,
      },
    }
  } catch (error) {
    return invalid(`malformed JSON (${browserErrorMessage(error)})`)
  }
}

// ── An Unreachable Proxy Degrades Before Browser Launch ──────────────
// ZAP is session-scoped and may disappear before a later browser phase starts.
// A bounded TCP probe checks the configured endpoint before Chromium receives
// immutable proxy flags. Failure selects the explicit direct-fallback state,
// keeping the browser usable while making the loss of interception observable.
// ─────────────────────────────────────────────────────────────────────

function proxyReachable(proxyUrl, timeoutMs = 1000) {
  let host, port
  try {
    const u = new URL(proxyUrl)
    host = u.hostname
    port = Number(u.port) || (u.protocol === "https:" ? 443 : 80)
  } catch (error) {
    if (error instanceof TypeError) return Promise.resolve(false)
    throw error
  }
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (open) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}

// ── Cookie Cleanup Happens Before Chromium Opens The Profile ─────────
// A persistent profile is useful for downloads and local state, but cookies can
// silently carry identity between agent runs. Startup cleanup removes known
// cookie stores first, then clearCookies runs after launch as a second pass.
// The opt-in runs once per process so later tools cannot erase live session state.
// ─────────────────────────────────────────────────────────────────────

function removeExistingCookieStoreFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return 0

  let removed = 0
  const stack = [{ dir: rootDir, depth: 0 }]
  const maxDepth = 4

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) continue
      throw error
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth && !COOKIE_SCAN_SKIP_DIRS.has(entry.name)) {
          stack.push({ dir: entryPath, depth: depth + 1 })
        }
        continue
      }

      if (!COOKIE_STORE_FILE_NAMES.has(entry.name)) continue
      try {
        fs.rmSync(entryPath, { force: true })
        removed += 1
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
    }
  }

  return removed
}

function prepareStartupCookieCleanup() {
  if (startupCookieCleanup.done) return false

  startupCookieCleanup = {
    done: true,
    enabled: envBool("CYBER_BROWSER_CLEAR_COOKIES_ON_START", false),
    removed_files: 0,
    context_cleared: false,
  }

  if (!startupCookieCleanup.enabled) return false

  startupCookieCleanup.removed_files = removeExistingCookieStoreFiles(USER_DATA_DIR)
  if (startupCookieCleanup.removed_files > 0) {
    eprint(`removed ${startupCookieCleanup.removed_files} existing browser cookie store file(s) before first launch`)
  }
  return true
}

function intArg(value, defaultValue, minimum, maximum) {
  if (value === undefined || value === null) return defaultValue
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`expected an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function timeoutArg(args) {
  return intArg(args.timeout_ms, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS)
}

function trimText(value, maxChars = DEFAULT_MAX_TEXT_CHARS) {
  const text = String(value ?? "")
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`
}

function textPreview(value, maxChars = 300) {
  return trimText(
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    maxChars,
  )
}

// ── Keyboard Input Rejects Accidental Nullish Text ───────────────────
// Browser form actions accept an empty string because clearing a field is a
// legitimate user operation. Nullish values and their common string coercions
// are rejected instead of typing "undefined" or "null" into the target page.
// The boundary error points callers back to the failed extraction or DOM read.
// ─────────────────────────────────────────────────────────────────────
function keyboardValue(value, field = "value") {
  if (value === undefined || value === null)
    throw new Error(
      `${field} is required — got ${value === null ? "null" : "undefined"}, which usually means a failed extraction upstream (a variable or DOM read that produced nothing)`,
    )
  const text = String(value)
  if (text === "undefined" || text === "null")
    throw new Error(
      `${field} is the literal "${text}" — a non-value coerced to text; capture the real value before typing it into the page`,
    )
  return text
}

function asJson(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch (error) {
    return JSON.stringify({ error: `not JSON serializable: ${error.message}` }, null, 2)
  }
}

function normalizeUrl(url) {
  const value = String(url || "").trim()
  if (!value) throw new Error("url is required")
  if (/^(https?|file|data|about|chrome):/i.test(value)) return value
  if (
    value.startsWith("localhost") ||
    value.startsWith("127.") ||
    value.startsWith("[::1]") ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(value)
  ) {
    return `http://${value}`
  }
  return `https://${value}`
}

// ── Every Browser Request Revalidates Its Destination ──────────────
// Exact-origin enforcement depends on the selected driver exposing both HTTP
// and WebSocket context routes. Driver selection may retain its compatibility
// fallbacks, because the policy installer validates those capabilities before
// Cyberful creates or selects a page. An unsupported fallback therefore fails
// closed only when the private scope is active; ordinary runs stay unchanged.
//
// ────────────────────────────────────────────────────────────────

async function loadPlaywright() {
  if (playwrightModule) return playwrightModule
  const stealth = envBool("CYBER_BROWSER_STEALTH", true)
  const candidates = stealth
    ? ["patchright-core", "patchright", "playwright-core"]
    : ["playwright-core", "patchright-core", "patchright"]
  const errors = []
  for (const name of candidates) {
    try {
      playwrightModule = await import(name)
      loadedDriverName = name
      if (stealth && name === "playwright-core") {
        eprint('stealth requested but patchright not installed; using playwright-core (run "npm run browser:install")')
      }
      return playwrightModule
    } catch (error) {
      errors.push(`${name}: ${error.message}`)
    }
  }
  throw new Error(
    `No Playwright driver installed. Run "npm install" from the mcps package root. Tried ${errors.join("; ")}`,
  )
}

async function chromiumExecutablePath() {
  if (process.env.CYBER_BROWSER_EXECUTABLE) {
    return process.env.CYBER_BROWSER_EXECUTABLE
  }
  if (cachedExecutablePath) return cachedExecutablePath
  const { chromium } = await loadPlaywright()
  cachedExecutablePath = chromium.executablePath()
  return cachedExecutablePath
}

function installHint(executablePath) {
  return [
    `Chromium binary not found at: ${executablePath}`,
    "",
    "Install the isolated browser with:",
    "  npm run browser:install",
    "",
    `Browser cache: ${BROWSERS_PATH}`,
  ].join("\n")
}

function launchViewport() {
  const width = envInt("CYBER_BROWSER_VIEWPORT_WIDTH", 1440, 320, 7680)
  const height = envInt("CYBER_BROWSER_VIEWPORT_HEIGHT", 1000, 240, 4320)
  return { width, height }
}

// ── Stealth Browser Selection ────────────────────────────────────────
// Targets fingerprint automation and block it before a pentest can even reach the
// app. The patchright driver (loaded in loadPlaywright) closes the driver-level
// tells; here we pick the browser binary. Default is the bundled Chrome-for-Testing
// (CYBER_BROWSER_CHANNEL=chromium): it is isolated and suppresses the "unsupported
// command-line flag" infobars that REAL Chrome shows for patchright's own
// webdriver-masking flag (--disable-blink-features=AutomationControlled — load-bearing,
// removing it re-exposes navigator.webdriver). Real Chrome's fingerprint is marginally
// more legitimate but renders those banners, so it is opt-in via "auto"/"chrome".
// ─────────────────────────────────────────────────────────────────────

function systemChromeExists() {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome", "/usr/bin/chrome"]
  return candidates.some((candidate) => fs.existsSync(candidate))
}

function resolveBrowserChannel() {
  if (!envBool("CYBER_BROWSER_STEALTH", true)) return null
  if (process.env.CYBER_BROWSER_EXECUTABLE) return null
  const pref = (process.env.CYBER_BROWSER_CHANNEL || "chromium").trim().toLowerCase()
  if (["chromium", "none", "off", ""].includes(pref)) return null
  if (pref === "chrome") return "chrome"
  return systemChromeExists() ? "chrome" : null
}

// ── Launch Or Attachment Establishes Explicit Ownership ──────────
// All tools share one context so snapshots, refs, network logs, cookies, and
// downloads describe the same session. A locally launched or newly created CDP
// context belongs to this process and is closed during teardown. An existing CDP
// context remains host-owned: this process may close only its own pinned tab and
// must never terminate sibling tabs or the shared browser.
// → cyberful/src/subsystem/gateway/server.ts — supplies the private CDP endpoint.
// ─────────────────────────────────────────────────────────────────────

async function ensureBrowser() {
  if (originPolicyFailure) throw originPolicyFailure
  if (context) return context

  ensureDir(BROWSERS_PATH)
  ensureDir(USER_DATA_DIR)
  ensureDir(ARTIFACTS_DIR)
  prepareBackgroundNetworkingProfile(USER_DATA_DIR)

  const { chromium } = await loadPlaywright()

  // ── CDP Attachment Preserves The Shared Session ────────────────────
  // An Expert gateway can point this process at the Agent's live browser so
  // cookies, tabs, and authenticated state remain available across the handoff.
  // Attachment never launches against the same profile and therefore avoids its
  // SingletonLock. Startup cookie cleanup is intentionally skipped for this path.
  // → cyberful/src/subsystem/gateway/server.ts — supplies the private CDP endpoint.
  // ─────────────────────────────────────────────────────────────────────
  if (CDP_ENDPOINT) return attachOverCdp(chromium, CDP_ENDPOINT)

  const clearCookiesAfterLaunch = prepareStartupCookieCleanup()

  const options = {
    ...browserOriginContextOptions(ALLOWED_ORIGINS),
    headless: envBool("CYBER_BROWSER_HEADLESS", false),
    viewport: launchViewport(),
    acceptDownloads: true,
    downloadsPath: ARTIFACTS_DIR,
    // Remove Patchright's duplicate flag so Chromium reads the complete policy superset first.
    ignoreDefaultArgs: [PATCHRIGHT_DISABLED_FEATURES_ARG],
    args: [
      ...BACKGROUND_NETWORKING_DISABLED_ARGS,
      "--disable-dev-shm-usage",
      "--no-default-browser-check",
      "--no-first-run",
      "--password-store=basic",
      "--use-mock-keychain",
      // ── Ephemeral CDP Port Enables A Private Handoff ─────────────────
      // Chromium writes its port-zero allocation to DevToolsActivePort for the
      // gateway to discover. The listener remains loopback-only, while Playwright
      // continues to own the primary pipe. CDP exists only for shared-session
      // attachment and is never advertised on an external network interface.
      // → cyberful/src/subsystem/gateway/server.ts — reads and forwards the endpoint.
      // ─────────────────────────────────────────────────────────────────────
      `--remote-debugging-port=${(process.env.CYBER_BROWSER_CDP_PORT || "").trim() || "0"}`,
    ],
  }
  // ── Stealth Runs With Chromium's Sandbox By Default ────────────────
  // Playwright normally disables Chromium's sandbox, exposing both a security
  // weakness and a visible automation signal. Stealth restores the sandbox unless
  // CYBER_BROWSER_SANDBOX explicitly opts out. Launch retains a compatibility
  // fallback for environments where the operating system cannot initialize it.
  // ─────────────────────────────────────────────────────────────────────
  options.chromiumSandbox = envBool("CYBER_BROWSER_STEALTH", true) && envBool("CYBER_BROWSER_SANDBOX", true)

  // Playwright requires exactly one of channel discovery or an explicit executable path.
  const channel = resolveBrowserChannel()
  if (channel) {
    options.channel = channel
    browserRuntime = {
      requested_channel: (process.env.CYBER_BROWSER_CHANNEL || "chromium").trim().toLowerCase(),
      resolved_channel: channel,
      executable_path: null,
      version: null,
      driver: loadedDriverName,
      connection: "persistent",
    }
    eprint(`launching via channel "${channel}" (${loadedDriverName || "playwright"})`)
  } else {
    const executablePath = await chromiumExecutablePath()
    if (!fs.existsSync(executablePath)) {
      throw new Error(installHint(executablePath))
    }
    options.executablePath = executablePath
    browserRuntime = {
      requested_channel: (process.env.CYBER_BROWSER_CHANNEL || "chromium").trim().toLowerCase(),
      resolved_channel: "chromium",
      executable_path: executablePath,
      version: null,
      driver: loadedDriverName,
      connection: "persistent",
    }
    eprint(`launching ${loadedDriverName || "playwright"} chromium at ${executablePath}`)
  }

  if (process.env.CYBER_BROWSER_PROXY_CA_SPKI) {
    // The engagement CA is trusted by SPKI pin; unrelated invalid certificates remain rejected.
    options.args.push(`--ignore-certificate-errors-spki-list=${process.env.CYBER_BROWSER_PROXY_CA_SPKI}`)
  }

  // ── ZAP Routing Cannot Be Bypassed By Browser Defaults ─────────────
  // A reachable engagement proxy receives ordinary target traffic, including
  // loopback targets, while QUIC is disabled so HTTP/3 cannot bypass it. Only
  // cyberful.invalid bypasses ZAP: Chrome's mandatory account probe is redirected
  // there by launch policy and must fail locally without polluting proxy history.
  // Probe failure records direct-fallback explicitly before Chromium launches.
  // ─────────────────────────────────────────────────────────────────────

  if (process.env.CYBER_BROWSER_PROXY) {
    const proxyUrl = process.env.CYBER_BROWSER_PROXY
    if (await proxyReachable(proxyUrl)) {
      options.proxy = { server: proxyUrl, bypass: "cyberful.invalid" }
      options.args.push("--disable-quic", "--proxy-bypass-list=cyberful.invalid;<-loopback>")
      proxyStatus = { configured: true, mode: "zap", warning: null }
    } else {
      const warning = `OWASP ZAP proxy ${proxyUrl} is unreachable; launching with a direct connection`
      proxyStatus = { configured: true, mode: "direct-fallback", warning }
      eprint(`WARNING: ${warning}`)
    }
  }

  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, options)
  } catch (error) {
    if (options.chromiumSandbox && /sandbox/i.test(String(error && error.message))) {
      eprint(`chromium sandbox failed to start (${error.message}); retrying without it`)
      options.chromiumSandbox = false
      context = await chromium.launchPersistentContext(USER_DATA_DIR, options)
    } else {
      throw error
    }
  }
  contextOwnership = "persistent"
  try {
    await installBrowserOriginPolicy(context, ALLOWED_ORIGINS)
  } catch (error) {
    originPolicyFailure = error
    const failedContext = context
    context = null
    contextOwnership = "none"
    await bestEffortBrowserOperation("origin-policy context cleanup", () => failedContext.close(), undefined, {
      allowClosed: true,
    })
    throw error
  }
  if (clearCookiesAfterLaunch) {
    await context.clearCookies()
    startupCookieCleanup.context_cleared = true
  }
  browserRuntime.version = context.browser()?.version() ?? null
  context.setDefaultTimeout(DEFAULT_TIMEOUT_MS)
  context.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS)
  const launchedContext = context

  // ── The Eager Hub Owns A Context But No Page ───────────────────────
  // The parked hub keeps the shared profile alive while scouts attach over CDP.
  // It never attaches page listeners, which would duplicate evidence and observe
  // scout-owned tabs. If its browser closes, the hub exits so the host observes
  // loss of the shared owner instead of leaving every scout on a dead endpoint.
  // Non-eager contexts continue to track pages and may recover after closure.
  // ─────────────────────────────────────────────────────────────────────

  launchedContext.on("page", (page) => {
    if (EAGER || context !== launchedContext) return
    activePage = page
    attachPage(page)
  })
  launchedContext.on("close", () => {
    if (context === launchedContext) {
      context = null
      contextOwnership = "none"
      activePage = null
    }
    if (EAGER) process.exit(0)
  })

  if (!EAGER) {
    for (const page of context.pages()) attachPage(page)
    activePage = context.pages()[0] || (await context.newPage())
    attachPage(activePage)
  }
  return context
}

// ── CDP Attachment Preserves External Context Ownership ──────────────
// An attached default context belongs to the shared browser owner and must not
// be closed, cookie-cleared, or profile-locked by this process. A context created
// only because none existed is locally owned. Disconnect drops every cached page
// handle so a later tool call reattaches cleanly. OWN_TAB creates and retains one
// private page rather than deriving ownership from the shared pages collection.
// ─────────────────────────────────────────────────────────────────────

async function attachOverCdp(chromium, endpoint) {
  eprint(`attaching to existing browser over CDP at ${endpoint}`)
  const browser = await chromium.connectOverCDP(endpoint)
  browserRuntime = {
    ...browserRuntime,
    version: browser.version(),
    driver: loadedDriverName,
    connection: "cdp-attached",
  }
  const existingContext = browser.contexts()[0] || null
  const attached = existingContext || (await browser.newContext(browserOriginContextOptions(ALLOWED_ORIGINS)))
  try {
    await installBrowserOriginPolicy(attached, ALLOWED_ORIGINS)
  } catch (error) {
    originPolicyFailure = error
    if (!existingContext) {
      await bestEffortBrowserOperation("CDP attachment context cleanup", () => attached.close(), undefined, {
        allowClosed: true,
      })
    }
    throw error
  }
  attached.setDefaultTimeout(DEFAULT_TIMEOUT_MS)
  attached.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS)
  attached.on("page", (page) => {
    if (OWN_TAB || context !== attached) return
    activePage = page
    attachPage(page)
  })
  browser.on("disconnected", () => {
    if (context === attached) {
      context = null
      contextOwnership = "none"
      activePage = null
      pinnedPage = null
      pinnedTargetId = null
    }
  })
  context = attached
  contextOwnership = existingContext ? "cdp-shared" : "cdp-created"
  if (OWN_TAB) {
    pinnedPage = await attached.newPage()
    pinnedTargetId = await pageTargetId(pinnedPage)
    attachPage(pinnedPage)
    activePage = pinnedPage
  } else {
    for (const page of attached.pages()) attachPage(page)
    activePage = attached.pages().find((page) => !page.isClosed()) || (await attached.newPage())
    attachPage(activePage)
  }
  return context
}

// ── Target Identity Is Stable Across CDP Connections ─────────────────
// Playwright page guids are local to one connection and cannot identify a tab
// across scout processes. The CDP target id can, so status reports it when a
// temporary session opens successfully. Failure returns null and affects only
// observability: routing still owns the pinned Playwright page handle directly.
// The temporary CDP session is always detached before this operation returns.
// ─────────────────────────────────────────────────────────────────────

async function pageTargetId(page) {
  let session = null
  try {
    session = await context.newCDPSession(page)
    const info = await session.send("Target.getTargetInfo")
    return info?.targetInfo?.targetId ?? null
  } catch (error) {
    reportBestEffortFailure("CDP target identification", error, { allowClosed: true })
    return null
  } finally {
    if (session) {
      await bestEffortBrowserOperation("CDP target session detach", () => session.detach(), undefined, {
        allowClosed: true,
      })
    }
  }
}

async function currentPage() {
  const browserContext = await ensureBrowser()
  if (OWN_TAB) {
    if (pinnedPage && !pinnedPage.isClosed()) return pinnedPage
    pinnedPage = await browserContext.newPage()
    pinnedTargetId = await pageTargetId(pinnedPage)
    attachPage(pinnedPage)
    activePage = pinnedPage
    return pinnedPage
  }
  if (activePage && !activePage.isClosed()) return activePage
  activePage = browserContext.pages().find((page) => !page.isClosed()) || (await browserContext.newPage())
  attachPage(activePage)
  return activePage
}

// ── Network Evidence Is Bounded And Secrets Are Redacted ─────────────
// Network logs are useful for debugging automation and API discovery, but they
// can contain credentials. Headers are compacted with auth and cookie fields
// redacted. Old entries are dropped at the fixed limit together with their
// stored response handles, bounding both retained metadata and response access.
// ─────────────────────────────────────────────────────────────────────

function compactHeaders(headers) {
  const result = {}
  for (const [key, value] of Object.entries(headers || {})) {
    if (["authorization", "cookie", "set-cookie", "proxy-authorization"].includes(key.toLowerCase())) {
      result[key] = "[redacted]"
    } else {
      result[key] = trimText(value, 1000)
    }
  }
  return result
}

function pushNetworkEntry(entry) {
  networkLog.push(entry)
  while (networkLog.length > DEFAULT_NETWORK_LIMIT) {
    const removed = networkLog.shift()
    if (removed) responseById.delete(removed.id)
  }
}

function attachPage(page) {
  if (attachedPages.has(page)) return
  attachedPages.add(page)

  page.on("domcontentloaded", () => {
    if (!OWN_TAB) activePage = page
  })
  page.on("framenavigated", (frame) => {
    if (!OWN_TAB && frame === page.mainFrame()) activePage = page
  })
  page.on("request", (request) => {
    const id = ++networkSequence
    requestIds.set(request, id)
    const postData = request.postData()
    const entry = {
      id,
      started_at: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      resource_type: request.resourceType(),
      status: null,
      status_text: null,
      failed: false,
      failure_text: null,
      post_data: postData ? trimText(postData, 2000) : null,
      request_headers: compactHeaders(request.headers()),
    }
    requestEntries.set(request, entry)
    pushNetworkEntry(entry)
  })
  page.on("response", (response) => {
    const request = response.request()
    const id = requestIds.get(request)
    const entry = requestEntries.get(request)
    if (!id || !entry) return
    entry.finished_at = new Date().toISOString()
    entry.status = response.status()
    entry.status_text = response.statusText()
    entry.response_url = response.url()
    entry.response_headers = compactHeaders(response.headers())
    responseById.set(id, response)
  })
  page.on("requestfailed", (request) => {
    const entry = requestEntries.get(request)
    if (!entry) return
    entry.finished_at = new Date().toISOString()
    entry.failed = true
    entry.failure_text = request.failure()?.errorText || "request failed"
  })
  page.on("download", (download) => {
    downloadQueue = downloadQueue
      .then(() =>
        saveBrowserDownload(download, {
          artifactsDir: ARTIFACTS_DIR,
          maxBytes: MAX_ARTIFACT_BYTES,
          timeoutMs: 60_000,
        }),
      )
      .then(
        (artifact) => eprint(`download saved: ${artifact.target} (${artifact.bytes} bytes)`),
        (error) => eprint(`download save failed: ${browserErrorMessage(error)}`),
      )
  })
}

async function pageSummary(page) {
  const title = await bestEffortBrowserOperation("page title read", () => page.title(), "", { allowClosed: true })
  return [`url: ${page.url()}`, `title: ${title}`].join("\n")
}

function isTimeoutError(error) {
  const message = String(error?.message || error)
  return error?.name === "TimeoutError" || /Timeout \d+ms exceeded/.test(message)
}

// ── Navigation Treats Committed Pages As Useful State ────────────────
// Modern pages may keep analytics, streams, or polling requests open forever.
// Navigation waits therefore prefer DOM readiness and recover committed pages
// after timeout or abort. Callers can inspect the usable state that already
// exists instead of losing it solely because a later readiness signal stalled.
// ─────────────────────────────────────────────────────────────────────

function normalizeLoadStateForNavigation(value) {
  const requested = value || "domcontentloaded"
  if (requested !== "networkidle") {
    return { waitUntil: requested, warning: "" }
  }
  return {
    waitUntil: "domcontentloaded",
    warning:
      'warning: wait_until="networkidle" is not used for browser_navigate because many modern pages keep background requests open; waited for domcontentloaded instead. Use browser_wait with a selector, text, or state="networkidle" when you explicitly need it.\n',
  }
}

function normalizeLoadStateForAction(value) {
  const requested = value || "domcontentloaded"
  if (requested !== "networkidle") {
    return { waitUntil: requested, warning: "" }
  }
  return {
    waitUntil: "domcontentloaded",
    warning:
      'warning: wait_until="networkidle" is not used for browser actions because background requests can stall automation; waited for domcontentloaded instead. Use browser_wait with a selector, text, or state="networkidle" when you explicitly need it.\n',
  }
}

async function recoverPartialNavigation(page, error, options = {}) {
  const message = String(error?.message || error)
  const aborted = message.includes("net::ERR_ABORTED")
  const timedOut = isTimeoutError(error)
  if (!aborted && !timedOut) return null

  await bestEffortBrowserOperation(
    "partial-navigation DOM readiness wait",
    () => page.waitForLoadState("domcontentloaded", { timeout: 1500 }),
    undefined,
    { allowTimeout: true, allowClosed: true },
  )
  const summary = await bestEffortBrowserOperation("partial-navigation summary", () => pageSummary(page), null, {
    allowClosed: true,
  })
  const currentUrl = page.url()
  if (!summary || currentUrl === "about:blank") return null

  const beforeUrl = options.beforeUrl || ""
  const targetUrl = options.targetUrl || ""
  const committed =
    aborted || currentUrl !== beforeUrl || currentUrl === targetUrl || (beforeUrl !== "" && beforeUrl === targetUrl)
  if (!committed) return null

  const waitUntil = options.waitUntil || "requested"
  const status = aborted ? "navigation aborted after commit" : `navigation committed before ${waitUntil} load state`
  const hint =
    timedOut && waitUntil === "networkidle"
      ? '\nhint: Prefer wait_until="domcontentloaded" for pages with background requests; use browser_wait for a specific selector or text when you need readiness.'
      : ""

  return toolResult(`${summary}\nstatus: ${status}\nwarning: ${message}${hint}\n`)
}

async function waitAfterAction(page, waitUntil, timeoutMs) {
  if (!waitUntil || waitUntil === "none") return ""
  const normalized = normalizeLoadStateForAction(waitUntil)
  try {
    await page.waitForLoadState(normalized.waitUntil, { timeout: timeoutMs })
    return normalized.warning
  } catch (error) {
    if (!isTimeoutError(error)) throw error
    return `${normalized.warning}warning: page did not reach ${normalized.waitUntil} within ${timeoutMs}ms; the action itself completed.\n`
  }
}

// ── Locators Resolve From One Explicit Target Policy ─────────────────
// Browser actions accept refs from snapshots or a small set of Playwright
// locator hints. One resolver gives those alternatives a stable precedence and
// prevents each action from inventing its own interpretation of ambiguous
// client input or silently accepting a target it cannot identify.
// ─────────────────────────────────────────────────────────────────────

function locatorSchema() {
  return {
    selector: {
      type: "string",
      description: "Playwright/CSS selector. Prefer refs from browser_snapshot when available.",
    },
    ref: {
      type: "string",
      description: "Element ref returned by browser_snapshot, e.g. e3.",
    },
    label: {
      type: "string",
      description: "Accessible label for form controls.",
    },
    placeholder: {
      type: "string",
      description: "Input placeholder text.",
    },
    text: {
      type: "string",
      description: "Visible text to target.",
    },
    exact: {
      type: "boolean",
      default: false,
      description: "Use exact matching for text, label, or placeholder locators.",
    },
  }
}

function targetLocator(page, args) {
  if (args.ref) {
    const ref = String(args.ref)
    const selector = refSelectors.get(ref) || `[data-cyber-browser-ref="${ref}"]`
    return page.locator(selector).first()
  }
  if (args.selector) return page.locator(String(args.selector)).first()
  if (args.label) return page.getByLabel(String(args.label), { exact: Boolean(args.exact) }).first()
  if (args.placeholder) {
    return page.getByPlaceholder(String(args.placeholder), { exact: Boolean(args.exact) }).first()
  }
  if (args.text) return page.getByText(String(args.text), { exact: Boolean(args.exact) }).first()
  throw new Error("Provide selector, ref, label, placeholder, or text.")
}

// ── Artifact Reads Stay Inside The Artifact Root ─────────────────────
// Downloaded files are external content. Relative reads resolve through the
// configured artifacts directory, while absolute paths are accepted only when
// their canonical relative path remains inside that same root. Traversal fails
// before bytes are loaded into an MCP response.
// ─────────────────────────────────────────────────────────────────────

async function resolveArtifactReadPath(requestedPath) {
  if (!requestedPath) throw new Error("path is required")
  const resolved = path.resolve(
    path.isAbsolute(requestedPath) ? requestedPath : path.join(ARTIFACTS_DIR, requestedPath),
  )
  const [artifactsRoot, canonicalFile] = await Promise.all([
    fs.promises.realpath(ARTIFACTS_DIR),
    fs.promises.realpath(resolved),
  ])
  const relative = path.relative(artifactsRoot, canonicalFile)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`artifact reads are restricted to ${ARTIFACTS_DIR}`)
  }
  return canonicalFile
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".png") return "image/png"
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".webp") return "image/webp"
  if (ext === ".gif") return "image/gif"
  if (ext === ".svg") return "image/svg+xml"
  if (ext === ".json") return "application/json"
  if (ext === ".html" || ext === ".htm") return "text/html"
  if (ext === ".txt" || ext === ".log" || ext === ".md") return "text/plain"
  return "application/octet-stream"
}

function isTextMime(mimeType) {
  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    mimeType.includes("javascript")
  )
}

function formatSnapshot(snapshot, maxTextChars) {
  refSelectors.clear()
  for (const element of snapshot.elements) {
    refSelectors.set(element.ref, element.selector)
  }

  const lines = [
    `url: ${snapshot.url}`,
    `title: ${snapshot.title}`,
    "",
    "visible_text:",
    trimText(snapshot.text, maxTextChars).trim(),
    "",
    "interactive_elements:",
  ]

  for (const element of snapshot.elements) {
    const pieces = [
      `ref=${element.ref}`,
      `${element.role || element.tag}<${element.tag}>`,
      `name="${textPreview(element.name, 180)}"`,
      `selector=${element.selector}`,
    ]
    if (element.type) pieces.push(`type=${element.type}`)
    if (element.placeholder) pieces.push(`placeholder="${textPreview(element.placeholder, 120)}"`)
    if (element.href) pieces.push(`href=${element.href}`)
    if (element.value) pieces.push(`value="${textPreview(element.value, 120)}"`)
    pieces.push(`rect=${element.rect.x},${element.rect.y},${element.rect.width}x${element.rect.height}`)
    lines.push(`- ${pieces.join(" ")}`)
  }

  return `${lines.join("\n").trim()}\n`
}

// ── Snapshot Converts The Live DOM Into Stable Agent Refs ────────────
// The page DOM is mutable and selector choice is error-prone. Each snapshot
// removes stale markers, stamps visible actionable elements with fresh short
// refs, and stores their selectors. Later actions can then target the reviewed
// page state through the same resolver instead of guessing a selector.
// ─────────────────────────────────────────────────────────────────────

async function captureSnapshot(page, maxTextChars, maxElements) {
  return page.evaluate(
    ({ maxTextChars: textLimit, maxElements: elementLimit }) => {
      const refAttr = "data-cyber-browser-ref"
      document.querySelectorAll(`[${refAttr}]`).forEach((element) => element.removeAttribute(refAttr))

      const trim = (value, limit) => {
        const text = String(value || "")
          .replace(/\s+/g, " ")
          .trim()
        return text.length > limit ? `${text.slice(0, limit)}...` : text
      }

      const isVisible = (element) => {
        const style = window.getComputedStyle(element)
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
          return false
        }
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }

      const implicitRole = (element) => {
        const tag = element.tagName.toLowerCase()
        if (tag === "a") return "link"
        if (tag === "button") return "button"
        if (tag === "textarea") return "textbox"
        if (tag === "select") return "combobox"
        if (tag === "input") {
          const type = (element.getAttribute("type") || "text").toLowerCase()
          if (["button", "submit", "reset"].includes(type)) return "button"
          if (type === "checkbox") return "checkbox"
          if (type === "radio") return "radio"
          return "textbox"
        }
        return element.getAttribute("role") || tag
      }

      const labelText = (element) => {
        const fromLabels = element.labels
          ? Array.from(element.labels)
              .map((label) => label.innerText)
              .join(" ")
          : ""
        const candidates = [
          element.getAttribute("aria-label"),
          fromLabels,
          element.innerText,
          element.getAttribute("value"),
          element.getAttribute("placeholder"),
          element.getAttribute("title"),
          element.getAttribute("alt"),
          element.getAttribute("name"),
          element.getAttribute("href"),
        ]
        return trim(candidates.find((candidate) => String(candidate || "").trim()) || "", 240)
      }

      const selector = [
        "a[href]",
        "button",
        "input",
        "textarea",
        "select",
        "summary",
        "[role]",
        "[contenteditable='true']",
        "[onclick]",
        "[tabindex]:not([tabindex='-1'])",
      ].join(",")

      const elements = []
      const nodes = Array.from(document.querySelectorAll(selector))
      for (const node of nodes) {
        if (elements.length >= elementLimit) break
        if (!isVisible(node)) continue
        const ref = `e${elements.length + 1}`
        node.setAttribute(refAttr, ref)
        const rect = node.getBoundingClientRect()
        elements.push({
          ref,
          tag: node.tagName.toLowerCase(),
          role: node.getAttribute("role") || implicitRole(node),
          name: labelText(node),
          type: node.getAttribute("type") || "",
          placeholder: node.getAttribute("placeholder") || "",
          href: node.href || "",
          value: node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? trim(node.value, 160) : "",
          selector: `[${refAttr}="${ref}"]`,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        })
      }

      const bodyText = document.body?.innerText || ""
      return {
        url: window.location.href,
        title: document.title,
        text: bodyText.length > textLimit ? `${bodyText.slice(0, textLimit)}\n[truncated]` : bodyText,
        elements,
      }
    },
    { maxTextChars, maxElements },
  )
}

function filteredNetwork(args) {
  const limit = intArg(args.limit, 50, 1, DEFAULT_NETWORK_LIMIT)
  const includeHeaders = Boolean(args.include_headers)
  const urlContains = args.url_contains ? String(args.url_contains) : ""
  const resourceType = args.resource_type ? String(args.resource_type) : ""
  const statusMin = args.status_min ? Number(args.status_min) : null
  const statusMax = args.status_max ? Number(args.status_max) : null
  const errorsOnly = Boolean(args.errors_only)

  let entries = [...networkLog]
  if (urlContains) entries = entries.filter((entry) => entry.url.includes(urlContains))
  if (resourceType) entries = entries.filter((entry) => entry.resource_type === resourceType)
  if (statusMin !== null) entries = entries.filter((entry) => (entry.status || 0) >= statusMin)
  if (statusMax !== null) entries = entries.filter((entry) => (entry.status || 0) <= statusMax)
  if (errorsOnly) {
    entries = entries.filter((entry) => entry.failed || (entry.status !== null && entry.status >= 400))
  }

  return entries.slice(-limit).map((entry) => {
    if (includeHeaders) return entry
    const { request_headers: _requestHeaders, response_headers: _responseHeaders, ...withoutHeaders } = entry
    return withoutHeaders
  })
}

function responseLooksTextual(headers) {
  const contentType = String(headers["content-type"] || "").toLowerCase()
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("javascript") ||
    contentType.includes("x-www-form-urlencoded")
  )
}

// ── Response Bodies Need A Proven Byte Budget ────────────────────────
// Playwright exposes completed response bodies as one Buffer rather than a
// stream. Reading an unknown, compressed, or oversized body would therefore
// allocate it before max_bytes could be applied. The tool accepts only an
// identity-encoded body with a valid Content-Length inside the caller's budget;
// callers can raise that budget up to the fixed server cap and retry.
// ─────────────────────────────────────────────────────────────────────

function declaredResponseBodyBytes(response, headers, maxBytes) {
  const method = response.request?.().method?.()
  if (method === "HEAD" || [204, 304].includes(response.status())) return 0
  const encoding = String(headers["content-encoding"] || "identity")
    .trim()
    .toLowerCase()
  if (encoding && encoding !== "identity") {
    throw new Error("response body cannot be read safely because Content-Encoding may expand after buffering")
  }
  const rawLength = String(headers["content-length"] ?? "").trim()
  if (!/^(0|[1-9]\d*)$/.test(rawLength)) {
    throw new Error("response body cannot be read safely without a valid Content-Length")
  }
  const length = Number(rawLength)
  if (!Number.isSafeInteger(length) || length > maxBytes) {
    throw new Error(`response declares ${rawLength} bytes, exceeding this call's ${maxBytes}-byte budget`)
  }
  return length
}

export async function readBoundedResponseBody(response, maxBytes) {
  const headers = response.headers()
  const declaredBytes = declaredResponseBodyBytes(response, headers, maxBytes)
  const body = await response.body()
  if (body.length > maxBytes || body.length > declaredBytes) {
    throw new Error(
      `response body produced ${body.length} bytes after declaring ${declaredBytes}; refusing the untrusted mismatch`,
    )
  }
  return { body, headers }
}

function captchaNetworkSignals(maxSignals, startedAfterMs = null) {
  const patterns = [
    { provider: "recaptcha", pattern: /recaptcha|google\.com\/sorry|google\.com\/sorry\/index/i },
    { provider: "hcaptcha", pattern: /hcaptcha\.com/i },
    { provider: "turnstile", pattern: /challenges\.cloudflare\.com|turnstile/i },
    { provider: "cloudflare", pattern: /cdn-cgi\/challenge-platform|cf_chl_|challenge-platform/i },
    { provider: "arkose", pattern: /arkoselabs|funcaptcha/i },
    { provider: "geetest", pattern: /geetest/i },
  ]

  const signals = []
  for (const entry of networkLog.slice(-DEFAULT_NETWORK_LIMIT)) {
    if (signals.length >= maxSignals) break
    if (startedAfterMs) {
      const startedAtMs = Date.parse(entry.started_at || "")
      if (Number.isFinite(startedAtMs) && startedAtMs < startedAfterMs) continue
    }
    const matched = patterns.find(({ pattern }) => pattern.test(entry.url))
    if (!matched) continue
    signals.push({
      provider: matched.provider,
      kind: "network",
      evidence: entry.url,
      method: entry.method,
      status: entry.status,
      resource_type: entry.resource_type,
    })
  }
  return signals
}

function captchaConfidence(signals) {
  if (!signals.length) return "none"
  if (
    signals.some(
      (signal) =>
        signal.provider !== "generic" ||
        ["iframe", "widget", "response_field", "challenge", "network", "url"].includes(signal.kind),
    )
  ) {
    return "high"
  }
  if (signals.some((signal) => signal.kind === "element" || signal.kind === "text")) return "medium"
  return "low"
}

// ── CAPTCHA Handling Detects And Hands Off Only ──────────────────────
// The browser MCP may identify challenge signals and pause for a human in the
// visible browser. It does not solve, bypass, inject tokens, or automate any
// challenge. The registered handoff tool only polls the same bounded signals
// until they disappear or its explicit timeout expires.
// ─────────────────────────────────────────────────────────────────────

async function detectCaptcha(page, maxSignals = 50, options = {}) {
  const domDetection = await page.evaluate((limit) => {
    const signals = []
    const pushSignal = (signal) => {
      if (signals.length >= limit) return
      signals.push(signal)
    }

    const compactText = (value, maxChars = 220) => {
      const text = String(value || "")
        .replace(/\s+/g, " ")
        .trim()
      return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text
    }

    const elementVisible = (element) => {
      const style = window.getComputedStyle(element)
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
        return false
      }
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }

    const selectorGroups = [
      {
        provider: "recaptcha",
        kind: "widget",
        selectors: [
          ".g-recaptcha",
          "iframe[src*='recaptcha']",
          "iframe[title*='recaptcha' i]",
          "textarea[name='g-recaptcha-response']",
          "[data-sitekey][class*='g-recaptcha']",
        ],
      },
      {
        provider: "hcaptcha",
        kind: "widget",
        selectors: [
          ".h-captcha",
          "iframe[src*='hcaptcha.com']",
          "iframe[title*='hcaptcha' i]",
          "textarea[name='h-captcha-response']",
        ],
      },
      {
        provider: "turnstile",
        kind: "widget",
        selectors: [
          ".cf-turnstile",
          "iframe[src*='challenges.cloudflare.com']",
          "input[name='cf-turnstile-response']",
          "textarea[name='cf-turnstile-response']",
        ],
      },
      {
        provider: "cloudflare",
        kind: "challenge",
        selectors: [
          "#challenge-running",
          "#challenge-stage",
          "#cf-challenge-running",
          ".cf-browser-verification",
          "[data-testid='challenge-form']",
          "form[action*='__cf_chl_f_tk']",
        ],
      },
      {
        provider: "arkose",
        kind: "widget",
        selectors: [
          "iframe[src*='arkoselabs']",
          "iframe[src*='funcaptcha']",
          "iframe[title*='challenge' i][src*='arkose']",
          "[data-pkey]",
        ],
      },
      {
        provider: "geetest",
        kind: "widget",
        selectors: [".geetest_panel", ".geetest_holder", "iframe[src*='geetest']"],
      },
      {
        provider: "generic",
        kind: "element",
        selectors: [
          "[id*='captcha' i]",
          "[class*='captcha' i]",
          "[name*='captcha' i]",
          "input[placeholder*='captcha' i]",
          "img[alt*='captcha' i]",
        ],
      },
    ]

    for (const group of selectorGroups) {
      for (const selector of group.selectors) {
        const elements = Array.from(document.querySelectorAll(selector))
        for (const element of elements) {
          const visible = elementVisible(element)
          const rect = element.getBoundingClientRect()
          const tag = element.tagName.toLowerCase()
          const src = element.getAttribute("src") || ""
          pushSignal({
            provider: group.provider,
            kind: tag === "iframe" ? "iframe" : tag === "textarea" || tag === "input" ? "response_field" : group.kind,
            selector,
            visible,
            text: compactText(element.innerText || element.getAttribute("aria-label") || element.getAttribute("title")),
            src: compactText(src, 300),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          })
        }
      }
    }

    const url = window.location.href
    const urlPatterns = [
      { provider: "cloudflare", pattern: /cdn-cgi\/challenge-platform|__cf_chl_|challenge-platform/i },
      { provider: "recaptcha", pattern: /google\.com\/sorry|recaptcha/i },
      { provider: "hcaptcha", pattern: /hcaptcha/i },
      { provider: "turnstile", pattern: /challenges\.cloudflare\.com|turnstile/i },
      { provider: "arkose", pattern: /arkoselabs|funcaptcha/i },
      { provider: "geetest", pattern: /geetest/i },
    ]
    for (const { provider, pattern } of urlPatterns) {
      if (pattern.test(url)) {
        pushSignal({ provider, kind: "url", evidence: compactText(url, 300), visible: true })
      }
    }

    const bodyText = document.body?.innerText || ""
    const textPatterns = [
      { provider: "generic", pattern: /\bcaptcha\b/i, evidence: "captcha" },
      { provider: "generic", pattern: /verify (that )?you are human/i, evidence: "verify you are human" },
      {
        provider: "generic",
        pattern: /prove (that )?you are (not )?(a )?(robot|bot)/i,
        evidence: "prove you are not a robot",
      },
      {
        provider: "cloudflare",
        pattern: /checking if the site connection is secure/i,
        evidence: "cloudflare security check",
      },
      { provider: "cloudflare", pattern: /verifying you are human/i, evidence: "cloudflare human verification" },
      { provider: "generic", pattern: /unusual traffic/i, evidence: "unusual traffic" },
    ]
    for (const { provider, pattern, evidence } of textPatterns) {
      if (pattern.test(bodyText)) {
        pushSignal({ provider, kind: "text", evidence, visible: true })
      }
    }

    return {
      url,
      title: document.title,
      signals,
    }
  }, maxSignals)

  const networkSignals =
    options.includeNetwork === false
      ? []
      : captchaNetworkSignals(Math.max(0, maxSignals - domDetection.signals.length), options.networkStartedAfterMs)
  const signals = [...domDetection.signals, ...networkSignals].slice(0, maxSignals)
  const providers = [...new Set(signals.map((signal) => signal.provider))].sort()
  const confidence = captchaConfidence(signals)

  return {
    detected: confidence !== "none",
    confidence,
    providers,
    signal_count: signals.length,
    signals,
    url: domDetection.url,
    title: domDetection.title,
  }
}

// ── Tool Registry Is The Browser MCP Contract ────────────────────────
// Each registered tool pairs a JSON schema with the handler that consumes it.
// The list exposed through tools/list and capabilities text is derived from
// this registry. One source therefore governs discovery and dispatch, so a
// public tool cannot be listed without an executable handler beside its schema.
// ─────────────────────────────────────────────────────────────────────

const TOOL_REGISTRY = []

function registerTool(name, description, inputSchema, handler) {
  TOOL_REGISTRY.push({ name, description, inputSchema, handler })
}

// ── Tool Schemas Are Runtime Boundaries ──────────────────────────────
// MCP schemas are executable contracts rather than discovery-only metadata.
// Every call is narrowed before its handler runs, including nested values and
// additional-property rules. Shared depth, collection, string, and byte budgets
// also bound permissive schema fields such as browser_evaluate's JSON argument.
// A malformed call fails as a tool result without starting Chromium or touching
// the artifacts directory.
// ─────────────────────────────────────────────────────────────────────

function inputError(pathLabel, message) {
  throw new Error(`invalid tool arguments at ${pathLabel}: ${message}`)
}

function jsonType(value) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function addJsonBytes(state, value, pathLabel) {
  let encoded
  try {
    encoded = JSON.stringify(value)
  } catch (error) {
    inputError(pathLabel, `value is not JSON serializable (${browserErrorMessage(error)})`)
  }
  state.bytes += Buffer.byteLength(encoded ?? "null")
  if (state.bytes > MAX_JSON_LINE_BYTES) {
    inputError(pathLabel, `encoded arguments exceed ${MAX_JSON_LINE_BYTES} bytes`)
  }
}

function validateSchemaValue(value, schema, pathLabel, depth, state) {
  if (depth > MAX_JSON_DEPTH) inputError(pathLabel, `nesting exceeds ${MAX_JSON_DEPTH} levels`)

  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    inputError(pathLabel, `expected one of ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(", ")}`)
  }

  const expectedType = schema.type
  const actualType = jsonType(value)
  if (expectedType === "integer") {
    if (!Number.isSafeInteger(value)) inputError(pathLabel, "expected an integer")
  } else if (expectedType === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) inputError(pathLabel, "expected a finite number")
  } else if (expectedType && actualType !== expectedType) {
    inputError(pathLabel, `expected ${expectedType}, got ${actualType}`)
  }

  if (typeof value === "string") {
    addJsonBytes(state, value, pathLabel)
    const maximum = Math.min(schema.maxLength ?? MAX_JSON_STRING_CHARS, MAX_JSON_STRING_CHARS)
    if (value.length > maximum) inputError(pathLabel, `string exceeds ${maximum} characters`)
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      inputError(pathLabel, `string must contain at least ${schema.minLength} characters`)
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      inputError(pathLabel, `string does not match ${schema.pattern}`)
    }
    return
  }

  if (typeof value === "number") {
    addJsonBytes(state, value, pathLabel)
    if (!Number.isFinite(value)) inputError(pathLabel, "expected a finite number")
    if (schema.minimum !== undefined && value < schema.minimum) {
      inputError(pathLabel, `value must be at least ${schema.minimum}`)
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      inputError(pathLabel, `value must be at most ${schema.maximum}`)
    }
    return
  }

  if (typeof value === "boolean" || value === null) {
    addJsonBytes(state, value, pathLabel)
    return
  }

  if (Array.isArray(value)) {
    state.bytes += 2
    const maximum = Math.min(schema.maxItems ?? MAX_JSON_ARRAY_ITEMS, MAX_JSON_ARRAY_ITEMS)
    if (value.length > maximum) inputError(pathLabel, `array exceeds ${maximum} items`)
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      inputError(pathLabel, `array must contain at least ${schema.minItems} items`)
    }
    for (const [index, item] of value.entries()) {
      state.bytes += index === 0 ? 0 : 1
      validateSchemaValue(item, schema.items ?? {}, `${pathLabel}[${index}]`, depth + 1, state)
    }
    return
  }

  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    inputError(pathLabel, "expected a JSON object")
  }

  const entries = Object.entries(value)
  if (entries.length > MAX_JSON_OBJECT_PROPERTIES) {
    inputError(pathLabel, `object exceeds ${MAX_JSON_OBJECT_PROPERTIES} properties`)
  }
  state.bytes += 2
  for (const required of schema.required ?? []) {
    if (!Object.hasOwn(value, required)) inputError(pathLabel, `missing required property ${required}`)
  }
  const properties = schema.properties ?? {}
  for (const [index, [key, item]] of entries.entries()) {
    state.bytes += (index === 0 ? 0 : 1) + Buffer.byteLength(JSON.stringify(key)) + 1
    if (state.bytes > MAX_JSON_LINE_BYTES)
      inputError(pathLabel, `encoded arguments exceed ${MAX_JSON_LINE_BYTES} bytes`)
    if (Object.hasOwn(properties, key)) {
      validateSchemaValue(item, properties[key], `${pathLabel}.${key}`, depth + 1, state)
      continue
    }
    if (schema.additionalProperties === false) inputError(pathLabel, `unknown property ${key}`)
    const additionalSchema =
      schema.additionalProperties && typeof schema.additionalProperties === "object" ? schema.additionalProperties : {}
    validateSchemaValue(item, additionalSchema, `${pathLabel}.${key}`, depth + 1, state)
  }
}

export function validateToolArguments(schema, args) {
  validateSchemaValue(args, schema, "arguments", 0, { bytes: 0 })
  return args
}

registerTool(
  "browser_status",
  "Attest the configured proxy for a dedicated blank browser, then report installation, runtime, and active page state.",
  {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  async () => {
    let executablePath = null
    let executableExists = false
    let dependencyInstalled = true
    let dependencyError = null
    try {
      executablePath = await chromiumExecutablePath()
      executableExists = fs.existsSync(executablePath)
    } catch (error) {
      dependencyInstalled = false
      dependencyError = error.message
    }

    // ── Status Resolves A Dedicated Proxy Without Navigating ──────────
    // Sequential phases own a fresh browser MCP rather than the Recon hub's
    // process-bound proxy attestation. Status may launch a blank context solely to
    // probe ZAP and bind immutable proxy flags before reporting readiness. A CDP
    // attachment stays pending because this process cannot attest its proxy setup.
    // No target URL is requested as part of this readiness operation.
    // ─────────────────────────────────────────────────────────────────────
    if (dependencyInstalled && !context && proxyStatus.mode === "pending" && !CDP_ENDPOINT) {
      await ensureBrowser()
    }

    const pages = []
    const visiblePages = context
      ? OWN_TAB
        ? context.pages().filter((page) => page === pinnedPage)
        : context.pages()
      : []
    for (const [index, page] of visiblePages.entries()) {
      pages.push({
        index,
        active: page === activePage,
        url: page.url(),
        title: await bestEffortBrowserOperation("status page title read", () => page.title(), "", {
          allowClosed: true,
        }),
        closed: page.isClosed(),
      })
    }

    return toolResult(
      `${asJson({
        server: SERVER_NAME,
        version: SERVER_VERSION,
        dependency_installed: dependencyInstalled,
        dependency_error: dependencyError,
        chromium_executable: executablePath,
        chromium_installed: executableExists,
        browser_cache: BROWSERS_PATH,
        user_data_dir: USER_DATA_DIR,
        artifacts_dir: ARTIFACTS_DIR,
        headless: envBool("CYBER_BROWSER_HEADLESS", false),
        clear_cookies_on_start: envBool("CYBER_BROWSER_CLEAR_COOKIES_ON_START", false),
        startup_cookie_cleanup: startupCookieCleanup,
        origin_policy: {
          enabled: ALLOWED_ORIGINS !== null,
          origin_count: ALLOWED_ORIGINS?.length ?? 0,
        },
        proxy: proxyStatus,
        runtime: browserRuntime,
        launched: Boolean(context),
        own_tab: OWN_TAB,
        pinned_target_id: pinnedTargetId,
        pages,
        install_command: "npm run browser:install",
      })}\n`,
      !dependencyInstalled,
    )
  },
)

registerTool(
  "browser_navigate",
  "Open a URL in the isolated Chromium page. Uses domcontentloaded by default; use browser_wait for selector/text readiness instead of networkidle.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", description: "URL to open. http:// is assumed for localhost/IP targets." },
      wait_until: {
        type: "string",
        enum: ["load", "domcontentloaded", "commit"],
        default: "domcontentloaded",
        description:
          "Load state to wait for. Prefer domcontentloaded; networkidle is intentionally not exposed here because analytics, streaming, or polling can keep it from settling. Use browser_wait for explicit readiness checks.",
      },
      timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
    },
    required: ["url"],
  },
  async (args) => {
    const targetUrl = normalizeUrl(args.url)
    if (!browserUrlAllowed(ALLOWED_ORIGINS, targetUrl)) {
      throw new Error("navigation blocked: URL origin is outside the Cyberful engagement scope")
    }

    const page = await currentPage()
    const timeoutMs = timeoutArg(args)
    const normalized = normalizeLoadStateForNavigation(args.wait_until)
    const waitUntil = normalized.waitUntil
    const beforeUrl = page.url()
    let response = null
    try {
      response = await page.goto(targetUrl, {
        waitUntil,
        timeout: timeoutMs,
      })
    } catch (error) {
      const recovered = await recoverPartialNavigation(page, error, { beforeUrl, targetUrl, waitUntil })
      if (recovered) return recovered
      throw error
    }
    const status = response ? `${response.status()} ${response.statusText()}` : "no response"
    return toolResult(`${await pageSummary(page)}\nstatus: ${status}\n${normalized.warning}`)
  },
)

registerTool(
  "browser_snapshot",
  "Return visible page text and actionable element refs for browser_click/fill/type.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      max_text_chars: {
        type: "integer",
        minimum: 100,
        maximum: 100_000,
        default: DEFAULT_MAX_TEXT_CHARS,
      },
      max_elements: { type: "integer", minimum: 1, maximum: 300, default: DEFAULT_MAX_ELEMENTS },
    },
  },
  async (args) => {
    const page = await currentPage()
    const maxTextChars = intArg(args.max_text_chars, DEFAULT_MAX_TEXT_CHARS, 100, 100_000)
    const maxElements = intArg(args.max_elements, DEFAULT_MAX_ELEMENTS, 1, 300)
    const snapshot = await captureSnapshot(page, maxTextChars, maxElements)
    return toolResult(formatSnapshot(snapshot, maxTextChars))
  },
)

registerTool(
  "browser_captcha_status",
  "Detect CAPTCHA or anti-bot challenge signals on the active page without solving or bypassing them.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      max_signals: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      include_network: {
        type: "boolean",
        default: true,
        description: "Include recent network requests to known challenge providers.",
      },
    },
  },
  async (args) => {
    const page = await currentPage()
    const maxSignals = intArg(args.max_signals, 50, 1, 200)
    const status = await detectCaptcha(page, maxSignals, { includeNetwork: args.include_network !== false })
    return toolResult(`${asJson(status)}\n`)
  },
)

registerTool(
  "browser_captcha_handoff",
  "Attest an already-visible CAPTCHA/challenge and bring the browser to the front. Then ask the human with the gateway question tool using kind=captcha; the host circuit breaker waits durably and requires a later browser_captcha_status clear result.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      timeout_ms: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
        description: "Deprecated compatibility input; handoff no longer expires inside the browser tool.",
      },
      poll_ms: {
        type: "integer",
        minimum: 250,
        maximum: 10_000,
        description:
          "Deprecated compatibility input; resolution is verified by browser_captcha_status after the human answer.",
      },
      require_detected: {
        type: "boolean",
        default: true,
        description: "Deprecated compatibility input; a visible challenge is always required.",
      },
      max_signals: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    },
  },
  async (args) => {
    const page = await currentPage()
    const maxSignals = intArg(args.max_signals, 50, 1, 200)
    const initial = await detectCaptcha(page, maxSignals, { includeNetwork: true })

    if (!initial.detected) {
      return toolResult(
        `${asJson({
          detected: false,
          resolved: true,
          action: "no_handoff_needed",
          message: "No CAPTCHA/challenge signals were detected on the active page.",
          status: initial,
        })}\n`,
      )
    }

    if (envBool("CYBER_BROWSER_HEADLESS", false)) {
      return toolResult(
        `${asJson({
          detected: initial.detected,
          resolved: false,
          action: "manual_handoff_unavailable",
          message:
            "Manual CAPTCHA/challenge handoff requires CYBER_BROWSER_HEADLESS=false so a user can interact with the browser window.",
          status: initial,
        })}\n`,
        true,
      )
    }

    await page.bringToFront()
    return toolResult(
      `${asJson({
        detected: true,
        resolved: false,
        action: "manual_handoff_ready",
        message:
          "The visible challenge is active and the browser is in front. Ask the human now through question kind=captcha, then call browser_captcha_status after the answer.",
        status: initial,
      })}\n`,
    )
  },
)

registerTool(
  "browser_click",
  "Click an element by snapshot ref, selector, label, placeholder, or text. The locator already scrolls the target into view; set force:true to also bypass the actionability checks (visible / stable / receives-events) that time out on an obscured or covered control, or when a captured selector is non-unique. force clicks whatever the locator resolves to, so it does NOT fix a wrong selector — prefer a precise ref from browser_snapshot.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      ...locatorSchema(),
      button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
      click_count: { type: "integer", minimum: 1, maximum: 3, default: 1 },
      force: {
        type: "boolean",
        default: false,
        description:
          "Bypass actionability checks (visible/stable/receives-events). Use for obscured or covered controls.",
      },
      no_wait_after: {
        type: "boolean",
        default: false,
        description: "Do not wait for navigations the click may start (Playwright noWaitAfter).",
      },
      wait_until: {
        type: "string",
        enum: ["none", "load", "domcontentloaded"],
        default: "domcontentloaded",
      },
      timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
    },
  },
  async (args) => {
    const page = await currentPage()
    const timeoutMs = timeoutArg(args)
    await targetLocator(page, args).click({
      button: args.button || "left",
      clickCount: intArg(args.click_count, 1, 1, 3),
      force: args.force === true,
      noWaitAfter: args.no_wait_after === true,
      timeout: timeoutMs,
    })
    const warning = await waitAfterAction(page, args.wait_until || "domcontentloaded", timeoutMs)
    return toolResult(`${await pageSummary(page)}\nclicked: true\n${warning}`)
  },
)

registerTool(
  "browser_fill",
  "Fill a form field by snapshot ref, selector, label, placeholder, or text.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      ...locatorSchema(),
      value: { type: "string", description: "Value to place in the field." },
      timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
    },
    required: ["value"],
  },
  async (args) => {
    const page = await currentPage()
    await targetLocator(page, args).fill(keyboardValue(args.value), { timeout: timeoutArg(args) })
    return toolResult(`${await pageSummary(page)}\nfilled: true\n`)
  },
)

registerTool(
  "browser_type",
  "Type text into an element or the active page.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      ...locatorSchema(),
      text_to_type: { type: "string", description: "Text to type." },
      delay_ms: { type: "integer", minimum: 0, maximum: 1000, default: 0 },
      timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
    },
    required: ["text_to_type"],
  },
  async (args) => {
    const page = await currentPage()
    const text = keyboardValue(args.text_to_type, "text_to_type")
    const delay = intArg(args.delay_ms, 0, 0, 1000)
    if (args.selector || args.ref || args.label || args.placeholder || args.text) {
      await targetLocator(page, args).type(text, { delay, timeout: timeoutArg(args) })
    } else {
      await page.keyboard.type(text, { delay })
    }
    return toolResult(`${await pageSummary(page)}\ntyped: true\n`)
  },
)

registerTool(
  "browser_select",
  "Select one or more values in a select element.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      ...locatorSchema(),
      value: { type: "string", description: "Single option value or label." },
      values: { type: "array", items: { type: "string" }, description: "Multiple option values or labels." },
      timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
    },
  },
  async (args) => {
    const page = await currentPage()
    const values = Array.isArray(args.values) ? args.values.map(String) : [String(args.value ?? "")]
    if (!values.length || values[0] === "") throw new Error("value or values is required")
    const selected = await targetLocator(page, args).selectOption(values, { timeout: timeoutArg(args) })
    return toolResult(`${await pageSummary(page)}\nselected: ${selected.join(", ")}\n`)
  },
)

// ── File Uploads Drive The Hidden Input Directly ─────────────────────
// Real upload UIs hide the <input type=file> behind a styled button, so this
// targets the input element itself (a browser_snapshot ref, or a selector like
// input[type=file]). setInputFiles does not run the visibility/actionability
// checks a click does, so a hidden input is the expected case, not an error.
// Source paths intentionally are not jailed: authorized engagements may upload
// a fixture from the repository, their workarea, or /tmp. This named tool is the
// explicit host-file boundary; its stat guard rejects missing and non-file paths
// loudly instead of presenting a zero-file "upload" as success.
// ─────────────────────────────────────────────────────────────────────
registerTool(
  "browser_set_input_files",
  "Upload local file(s) to a file input. Target the <input type=file> itself (a browser_snapshot ref or a selector like input[type=file]); a hidden input is fine. Uploading multiple files needs the input to allow multiple.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      ...locatorSchema(),
      file: { type: "string", description: "Path to a single local file to upload." },
      files: { type: "array", items: { type: "string" }, description: "Paths to multiple local files." },
      timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
    },
  },
  async (args) => {
    const page = await currentPage()
    const files = Array.isArray(args.files) ? args.files.map(String) : args.file ? [String(args.file)] : []
    if (!files.length) throw new Error("file or files is required")
    for (const filePath of files) {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`not a file: ${filePath}`)
    }
    await targetLocator(page, args).setInputFiles(files, { timeout: timeoutArg(args) })
    return toolResult(`${await pageSummary(page)}\nuploaded: ${files.length} file(s)\n`)
  },
)

// ── Scroll Is The Fallback A Click Doesn't Cover ─────────────────────
// browser_click already scrolls its target into view, so this exists for the
// gaps it leaves: reveal a specific element (scrollIntoViewIfNeeded, same
// locator policy) when its actionability keeps timing out, or wheel-scroll the
// viewport by a pixel delta to trigger lazy-loaded content no locator names yet.
// ─────────────────────────────────────────────────────────────────────
registerTool(
  "browser_scroll",
  "Scroll a target element into view (by ref/selector/label/placeholder/text), or wheel-scroll the viewport by a pixel delta when no locator is given.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      ...locatorSchema(),
      x: { type: "integer", description: "Horizontal wheel delta in px. Used only when no locator is given." },
      y: { type: "integer", description: "Vertical wheel delta in px. Used only when no locator is given." },
      timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
    },
  },
  async (args) => {
    const page = await currentPage()
    if (args.selector || args.ref || args.label || args.placeholder || args.text) {
      await targetLocator(page, args).scrollIntoViewIfNeeded({ timeout: timeoutArg(args) })
      return toolResult(`${await pageSummary(page)}\nscrolled: into view\n`)
    }
    const dx = intArg(args.x, 0, -100_000, 100_000)
    const dy = intArg(args.y, 0, -100_000, 100_000)
    await page.mouse.wheel(dx, dy)
    return toolResult(`${await pageSummary(page)}\nscrolled: ${dx},${dy}\n`)
  },
)

registerTool(
  "browser_check",
  "Set a checkbox or radio input checked state.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      ...locatorSchema(),
      checked: { type: "boolean", default: true },
      timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
    },
  },
  async (args) => {
    const page = await currentPage()
    await targetLocator(page, args).setChecked(args.checked !== false, { timeout: timeoutArg(args) })
    return toolResult(`${await pageSummary(page)}\nchecked: ${args.checked !== false}\n`)
  },
)

registerTool(
  "browser_press",
  "Press a keyboard key on an element or the active page.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      ...locatorSchema(),
      key: { type: "string", description: "Playwright key name, e.g. Enter, Escape, Meta+A." },
      timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
    },
    required: ["key"],
  },
  async (args) => {
    const page = await currentPage()
    if (args.selector || args.ref || args.label || args.placeholder || args.text) {
      await targetLocator(page, args).press(String(args.key), { timeout: timeoutArg(args) })
    } else {
      await page.keyboard.press(String(args.key))
    }
    return toolResult(`${await pageSummary(page)}\npressed: ${args.key}\n`)
  },
)

registerTool(
  "browser_wait",
  "Wait for a selector, text, load state, or fixed duration.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      selector: { type: "string" },
      text: { type: "string" },
      state: {
        type: "string",
        enum: ["visible", "attached", "detached", "hidden", "load", "domcontentloaded", "networkidle"],
        default: "visible",
      },
      milliseconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS },
      timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
    },
  },
  async (args) => {
    const page = await currentPage()
    const timeoutMs = timeoutArg(args)
    if (args.milliseconds) {
      await page.waitForTimeout(intArg(args.milliseconds, 1000, 1, MAX_TIMEOUT_MS))
    } else if (args.selector) {
      const state = ["visible", "attached", "detached", "hidden"].includes(args.state) ? args.state : "visible"
      await page.locator(String(args.selector)).first().waitFor({
        state,
        timeout: timeoutMs,
      })
    } else if (args.text) {
      const state = ["visible", "attached", "detached", "hidden"].includes(args.state) ? args.state : "visible"
      await page.getByText(String(args.text)).first().waitFor({ state, timeout: timeoutMs })
    } else {
      const state = ["load", "domcontentloaded", "networkidle"].includes(args.state) ? args.state : "domcontentloaded"
      await page.waitForLoadState(state, { timeout: timeoutMs })
    }
    return toolResult(`${await pageSummary(page)}\nwaited: true\n`)
  },
)

registerTool(
  "browser_artifact_list",
  "List downloads and other files saved by the browser MCP artifacts directory.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
    },
  },
  async (args) => {
    await fs.promises.mkdir(ARTIFACTS_DIR, { recursive: true })
    const limit = intArg(args.limit, 100, 1, 500)
    const entries = []
    let scannedEntries = 0
    let scanTruncated = false
    const directory = await fs.promises.opendir(ARTIFACTS_DIR)
    for await (const entry of directory) {
      if (scannedEntries >= MAX_ARTIFACT_SCAN_ENTRIES) {
        scanTruncated = true
        break
      }
      scannedEntries += 1
      if (!entry.isFile()) continue
      const filePath = path.join(ARTIFACTS_DIR, entry.name)
      let stat
      try {
        stat = await fs.promises.stat(filePath)
      } catch (error) {
        if (error?.code === "ENOENT") continue
        throw error
      }
      entries.push({
        name: entry.name,
        path: filePath,
        size: stat.size,
        modified_at: stat.mtime.toISOString(),
        mime_type: mimeTypeForPath(filePath),
      })
      entries.sort((a, b) => b.modified_at.localeCompare(a.modified_at))
      if (entries.length > limit) entries.pop()
    }

    return toolResult(
      `${asJson({
        artifacts_dir: ARTIFACTS_DIR,
        count: entries.length,
        scanned_entries: scannedEntries,
        scan_truncated: scanTruncated,
        entries,
      })}\n`,
    )
  },
)

registerTool(
  "browser_artifact_read",
  "Read a saved browser artifact by path/name. Images are returned as MCP image content.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "Artifact name or full path under the browser artifacts directory.",
      },
      max_bytes: {
        type: "integer",
        minimum: 1,
        maximum: MAX_ARTIFACT_BYTES,
        default: MAX_ARTIFACT_BYTES,
      },
      omit_data: {
        type: "boolean",
        default: false,
        description: "Return only metadata, not file content.",
      },
    },
    required: ["path"],
  },
  async (args) => {
    const filePath = await resolveArtifactReadPath(args.path)
    const maxBytes = intArg(args.max_bytes, MAX_ARTIFACT_BYTES, 1, MAX_ARTIFACT_BYTES)
    const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error(`not a file: ${filePath}`)
      const truncated = stat.size > maxBytes
      const mimeType = mimeTypeForPath(filePath)
      const metadata = {
        path: filePath,
        size: stat.size,
        modified_at: stat.mtime.toISOString(),
        mime_type: mimeType,
        truncated,
      }
      const content = [{ type: "text", text: `${asJson(metadata)}\n` }]

      if (args.omit_data) return { content, isError: false }

      const data = Buffer.alloc(Math.min(stat.size, maxBytes))
      let offset = 0
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      const retained = offset === data.length ? data : data.subarray(0, offset)
      if (mimeType.startsWith("image/") && !truncated) {
        content.push({ type: "image", data: retained.toString("base64"), mimeType })
      } else if (isTextMime(mimeType)) {
        content.push({
          type: "text",
          text: `${retained.toString("utf8")}${truncated ? "\n[truncated]" : ""}\n`,
        })
      } else {
        content.push({
          type: "text",
          text: `${asJson({ encoding: "base64", data: retained.toString("base64") })}\n`,
        })
      }
      return { content, isError: false }
    } finally {
      await handle.close()
    }
  },
)

registerTool(
  "browser_network_log",
  "Return recent captured network requests and responses from the active browser context.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: DEFAULT_NETWORK_LIMIT, default: 50 },
      url_contains: { type: "string" },
      resource_type: { type: "string", description: "Playwright resource type, e.g. document, xhr, fetch." },
      status_min: { type: "integer", minimum: 100, maximum: 599 },
      status_max: { type: "integer", minimum: 100, maximum: 599 },
      errors_only: { type: "boolean", default: false },
      include_headers: { type: "boolean", default: false },
    },
  },
  async (args) => {
    await ensureBrowser()
    const entries = filteredNetwork(args)
    return toolResult(`${asJson({ count: entries.length, entries })}\n`)
  },
)

registerTool(
  "browser_network_response_body",
  "Read a response body by network request id from browser_network_log.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "integer", minimum: 1, description: "Network request id." },
      max_bytes: { type: "integer", minimum: 1, maximum: MAX_BODY_BYTES, default: 256 * 1024 },
    },
    required: ["id"],
  },
  async (args) => {
    const id = Number(args.id)
    const response = responseById.get(id)
    if (!response) throw new Error(`No response stored for network id ${id}`)
    const maxBytes = intArg(args.max_bytes, 256 * 1024, 1, MAX_BODY_BYTES)
    const { body, headers } = await readBoundedResponseBody(response, maxBytes)
    if (responseLooksTextual(headers)) {
      return toolResult(
        `${asJson({
          id,
          url: response.url(),
          status: response.status(),
          content_type: headers["content-type"] || "",
          bytes: body.length,
          truncated: false,
        })}\n\nbody:\n${body.toString("utf8")}\n`,
      )
    }
    return toolResult(
      `${asJson({
        id,
        url: response.url(),
        status: response.status(),
        content_type: headers["content-type"] || "",
        bytes: body.length,
        truncated: false,
        encoding: "base64",
        body: body.toString("base64"),
      })}\n`,
    )
  },
)

registerTool(
  "browser_evaluate",
  "Run JavaScript in the active page. The script may be an expression or an async function body; use return to emit a value from a body.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      script: {
        type: "string",
        description: 'JavaScript expression or async function body, e.g. "location.href" or "return location.href".',
      },
      arg: { description: "Optional JSON-serializable argument exposed as arg." },
      timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
    },
    required: ["script"],
  },
  async (args) => {
    const page = await currentPage()
    page.setDefaultTimeout(timeoutArg(args))
    let result
    try {
      result = await page.evaluate(
        async ({ script, arg, maxOutputChars, maxArrayItems, maxObjectProperties }) => {
          const compile = (source, mode) => {
            const expressionSource = source.trim().replace(/;+\s*$/, "")
            const body =
              mode === "expression"
                ? `"use strict"; return (async () => (await (${expressionSource})))();`
                : `"use strict"; return (async () => {\n${source}\n})();`
            return new Function("arg", body)
          }

          let fn
          try {
            fn = compile(script, "expression")
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error
            fn = compile(script, "body")
          }
          const value = await fn(arg)
          const seen = new WeakSet()
          let remaining = maxOutputChars
          let truncated = false
          const preview = (candidate, depth = 0) => {
            if (candidate === null || typeof candidate === "boolean" || typeof candidate === "number") {
              remaining -= 16
              return candidate
            }
            if (typeof candidate === "string") {
              const retained = candidate.slice(0, Math.max(0, remaining))
              remaining -= retained.length
              if (retained.length < candidate.length) truncated = true
              return retained
            }
            if (["undefined", "function", "symbol", "bigint"].includes(typeof candidate)) {
              const rendered = `[${typeof candidate} value omitted]`
              remaining -= rendered.length
              return rendered
            }
            if (depth >= 12 || remaining <= 0) {
              truncated = true
              return "[truncated]"
            }
            if (seen.has(candidate)) return "[circular]"
            seen.add(candidate)
            if (Array.isArray(candidate)) {
              const retained = []
              for (const item of candidate) {
                if (retained.length >= maxArrayItems || remaining <= 0) {
                  truncated = true
                  break
                }
                retained.push(preview(item, depth + 1))
              }
              return retained
            }
            const retained = {}
            let count = 0
            for (const key in candidate) {
              if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue
              if (count >= maxObjectProperties || remaining <= 0) {
                truncated = true
                break
              }
              remaining -= key.length
              retained[key] = preview(candidate[key], depth + 1)
              count += 1
            }
            return retained
          }
          const serialized = JSON.stringify(preview(value), null, 2) ?? "undefined"
          if (serialized.length > maxOutputChars) truncated = true
          return { text: serialized.slice(0, maxOutputChars), truncated }
        },
        {
          script: args.script,
          arg: args.arg,
          maxOutputChars: MAX_EVALUATE_OUTPUT_CHARS,
          maxArrayItems: MAX_JSON_ARRAY_ITEMS,
          maxObjectProperties: MAX_JSON_OBJECT_PROPERTIES,
        },
      )
    } finally {
      page.setDefaultTimeout(DEFAULT_TIMEOUT_MS)
    }
    return toolResult(`${result.text}${result.truncated ? "\n[truncated evaluation result]" : ""}\n`)
  },
)

registerTool(
  "browser_cookies",
  "List, set, or clear cookies in the isolated browser context.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["list", "set", "clear"], default: "list" },
      urls: { type: "array", items: { type: "string" }, description: "URLs to scope cookie listing." },
      cookies: {
        type: "array",
        description: "Cookies for action=set, matching Playwright addCookies shape.",
        items: { type: "object" },
      },
    },
  },
  async (args) => {
    const browserContext = await ensureBrowser()
    const action = args.action || "list"
    if (action === "clear") {
      await browserContext.clearCookies()
      return toolResult("cookies cleared\n")
    }
    if (action === "set") {
      if (!Array.isArray(args.cookies)) throw new Error("cookies array is required for action=set")
      await browserContext.addCookies(args.cookies)
      return toolResult(`cookies set: ${args.cookies.length}\n`)
    }
    const urls = Array.isArray(args.urls) ? args.urls.map(normalizeUrl) : undefined
    const cookies = await browserContext.cookies(urls)
    return toolResult(`${asJson(cookies)}\n`)
  },
)

registerTool(
  "browser_close",
  "Release this process's browser session without closing a host-owned shared browser.",
  {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  async () => {
    await closeCurrentBrowser()
    return toolResult("browser closed\n")
  },
)

function capabilitiesText() {
  const tools = TOOL_REGISTRY.map((tool) => `- \`${tool.name}\`: ${tool.description}`).join("\n")
  return `# ${SERVER_NAME} MCP capabilities

This MCP server exposes an isolated, stealth-hardened Chromium browser (patchright driver) for browser-use style automation.

${tools}

CAPTCHA/challenge handling:
- This browser runs a stealth driver so it presents as a normal user browser; authorized targets do not block it up front. It does not auto-solve CAPTCHAs.
- First take the normal page action that makes the challenge visible. \`browser_captcha_handoff\` then attests it and surfaces the browser; ask the human with gateway \`question\` kind \`captcha\`, then verify the clear state with \`browser_captcha_status\`. The host breaker blocks other active tools in between.

Navigation guidance:
- Prefer \`wait_until="domcontentloaded"\` for ordinary page opens.
- \`browser_navigate\` and post-click waits do not expose \`networkidle\`; wait for a specific selector/text with \`browser_wait\` instead.
- Use \`browser_wait state="networkidle"\` only when you explicitly need network quietness and are prepared for it to time out.

Isolation defaults:
- browser binary cache: \`${BROWSERS_PATH}\`
- profile/user data: \`${USER_DATA_DIR}\`
- artifacts/downloads: \`${ARTIFACTS_DIR}\`
- launch mode: ${envBool("CYBER_BROWSER_HEADLESS", false) ? "headless" : "headed"}
- exact-origin request policy: ${ALLOWED_ORIGINS === null ? "disabled" : `enabled (${ALLOWED_ORIGINS.length} origin(s))`}
- existing target cookies persist in the dedicated Cyberful profile; set \`CYBER_BROWSER_CLEAR_COOKIES_ON_START=true\` for an intentionally clean engagement

Install Chromium:
\`\`\`sh
npm run browser:install
\`\`\`

Environment variables:
- \`CYBER_BROWSER_BROWSERS_PATH\`: override the isolated browser binary cache.
- \`CYBER_BROWSER_USER_DATA_DIR\`: override the persistent browser profile.
- \`CYBER_BROWSER_ARTIFACTS_DIR\`: override artifacts/downloads output.
- \`CYBER_BROWSER_HEADLESS=true\`: run Chromium without a visible macOS window.
- \`CYBER_BROWSER_EXECUTABLE\`: use a specific Chromium-compatible executable.
- \`CYBER_BROWSER_PROXY\`: route browser traffic through the engagement proxy.
- \`CYBER_BROWSER_PROXY_CA_SPKI\`: trust only the engagement proxy's generated MITM CA.
- \`CYBER_BROWSER_ALLOWED_ORIGINS\`: private JSON string array of exact HTTP(S)/WS(S) origins; when present, all other browser request origins are blocked.
- \`CYBER_BROWSER_STEALTH=false\`: disable the stealth driver and channel selection (default on).
- \`CYBER_BROWSER_CHANNEL\`: \`chromium\` (default; bundled Chrome-for-Testing, no infobars), \`auto\` (prefer real Chrome if present), or \`chrome\` (force real Chrome).
- \`CYBER_BROWSER_SANDBOX=false\`: launch with --no-sandbox (only if the OS sandbox can't start in your environment).
- \`CYBER_BROWSER_CLEAR_COOKIES_ON_START=true\`: clear cookies once before launch instead of reusing the dedicated profile's target login.
`
}

// ── Fail Tool Calls As Tool Results, Not Server Crashes ──────────────
// Page operations are allowed to fail because websites change underneath the
// agent. Handler exceptions become MCP tool errors and preserve the server for
// subsequent calls. Protocol-level request failures remain JSON-RPC errors so
// clients can distinguish invalid transport requests from website failures.
// ─────────────────────────────────────────────────────────────────────

export async function handleToolCall(params) {
  try {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("tool call params must be an object")
    }
    if (typeof params.name !== "string" || !params.name || params.name.length > 128) {
      throw new Error("tool name must be a non-empty string of at most 128 characters")
    }
    const tool = TOOL_REGISTRY.find((candidate) => candidate.name === params.name)
    if (!tool) return toolResult(`unknown tool: ${params.name}\n`, true)
    const args = params.arguments === undefined ? {} : params.arguments
    validateToolArguments(tool.inputSchema, args)
    return await tool.handler(args)
  } catch (error) {
    return toolException(error)
  }
}

async function handleRequest(message) {
  const id = message.id
  const method = message.method
  const params = message.params || {}
  if (id === undefined || id === null) return

  try {
    if (method === "initialize") {
      ok(id, {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: capabilitiesText(),
      })
    } else if (method === "ping") {
      ok(id, {})
    } else if (method === "tools/list") {
      ok(id, {
        tools: TOOL_REGISTRY.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      })
    } else if (method === "tools/call") {
      ok(id, await handleToolCall(params))
    } else if (method === "resources/list") {
      ok(id, {
        resources: [
          {
            uri: "mcp://browser/capabilities",
            name: "browser capabilities",
            description: "Browser automation tools and isolation defaults.",
            mimeType: "text/markdown",
          },
        ],
      })
    } else if (method === "resources/read") {
      if (params.uri !== "mcp://browser/capabilities") {
        err(id, -32602, `unknown resource: ${params.uri}`)
      } else {
        ok(id, {
          contents: [
            {
              uri: params.uri,
              mimeType: "text/markdown",
              text: capabilitiesText(),
            },
          ],
        })
      }
    } else if (method === "prompts/list") {
      ok(id, { prompts: [] })
    } else if (method === "completion/complete") {
      ok(id, { completion: { values: [] } })
    } else {
      err(id, -32601, `method not found: ${method}`)
    }
  } catch (error) {
    eprint(`${method} failed: ${error.name || "Error"}: ${error.message || String(error)}`)
    if (method === "tools/call") {
      ok(id, toolException(error))
    } else {
      err(id, -32000, error.message || String(error))
    }
  }
}

// ── Browser Shutdown Respects Context Ownership ─────────────────────
// EOF and process signals can race while Chromium still owns its persistent
// profile lock. One retained promise serializes teardown. Locally owned contexts
// are closed; an attached shared context is only forgotten, except that OWN_TAB
// mode closes the single tab it created. Signal handlers observe the retained
// promise and report failures only on stderr, preserving the stdio protocol.
// ─────────────────────────────────────────────────────────────────────

let browserShutdown
let browserSignalShutdown
async function closeCurrentBrowser() {
  const closingContext = context
  const closingOwnership = contextOwnership
  const closingPinnedPage = pinnedPage

  context = null
  contextOwnership = "none"
  activePage = null
  pinnedPage = null
  pinnedTargetId = null

  await releaseBrowserContext({
    context: closingContext,
    ownership: closingOwnership,
    ownTab: OWN_TAB,
    pinnedPage: closingPinnedPage,
  })
  await downloadQueue
}

function closeBrowser() {
  browserShutdown ??= closeCurrentBrowser()
  return browserShutdown
}

function closeBrowserForSignal(signal) {
  browserSignalShutdown ??= closeBrowser().then(
    () => process.exit(0),
    (error) => {
      eprint(`${signal} shutdown failed: ${error.message || String(error)}`)
      process.exit(1)
    },
  )
}

// ── Stdio Framing Is Bounded Before JSON Decoding ────────────────────
// A newline-delimited transport must not let one missing newline retain an
// arbitrary amount of client data. This scanner keeps at most one fixed-size
// line, discards the remainder of an oversized frame, and resumes at the next
// newline. Batch cardinality is checked after decoding so a compact array cannot
// turn one frame into unbounded sequential work.
// ─────────────────────────────────────────────────────────────────────

export async function* boundedJsonLines(input, maxBytes = MAX_JSON_LINE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer")
  let retained = Buffer.alloc(0)
  let discarding = false
  const decoder = new TextDecoder("utf-8", { fatal: true })

  for await (const rawChunk of input) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start)
      const end = newline === -1 ? chunk.length : newline
      const segment = chunk.subarray(start, end)
      if (!discarding) {
        if (retained.length + segment.length > maxBytes) {
          retained = Buffer.alloc(0)
          discarding = true
        } else if (segment.length > 0) {
          retained = Buffer.concat([retained, segment], retained.length + segment.length)
        }
      }

      if (newline === -1) break
      if (discarding) {
        yield { error: `input line exceeds ${maxBytes} bytes` }
      } else {
        const line = retained.at(-1) === 0x0d ? retained.subarray(0, -1) : retained
        try {
          yield { line: decoder.decode(line) }
        } catch {
          yield { error: "input line is not valid UTF-8" }
        }
      }
      retained = Buffer.alloc(0)
      discarding = false
      start = newline + 1
    }
  }

  if (discarding) {
    yield { error: `input line exceeds ${maxBytes} bytes` }
  } else if (retained.length > 0) {
    const line = retained.at(-1) === 0x0d ? retained.subarray(0, -1) : retained
    try {
      yield { line: decoder.decode(line) }
    } catch {
      yield { error: "input line is not valid UTF-8" }
    }
  }
}

function requestEnvelopeError(message) {
  try {
    validateSchemaValue(message, {}, "request", 0, { bytes: 0 })
  } catch (error) {
    return browserErrorMessage(error).replace(/^Error: invalid tool arguments at /, "invalid request at ")
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return "request must be an object"
  if (message.jsonrpc !== "2.0") return 'jsonrpc must equal "2.0"'
  if (typeof message.method !== "string" || !message.method || message.method.length > 128) {
    return "method must be a non-empty string of at most 128 characters"
  }
  if (
    message.params !== undefined &&
    (!message.params || typeof message.params !== "object" || Array.isArray(message.params))
  ) {
    return "params must be an object"
  }
  if (
    message.id !== undefined &&
    message.id !== null &&
    typeof message.id !== "string" &&
    !(typeof message.id === "number" && Number.isSafeInteger(message.id))
  ) {
    return "id must be a string, integer, null, or omitted"
  }
  return null
}

async function main() {
  eprint("stdio server started")
  process.once("SIGINT", () => closeBrowserForSignal("SIGINT"))
  process.once("SIGTERM", () => closeBrowserForSignal("SIGTERM"))
  if (EAGER) {
    // ── Eager Hub Mode Holds The Shared Browser ───────────────────────
    // The host launches this mode to keep one pinned profile alive while Recon
    // scouts attach through its ephemeral CDP endpoint. It cannot enter the normal
    // stdin loop because ignored stdin would produce immediate EOF and close the
    // shared browser. SIGINT or SIGTERM closes the context and releases its lock.
    // ─────────────────────────────────────────────────────────────────────
    await ensureBrowser()
    send({
      type: "cyberful-browser-ready",
      version: 1,
      proxy: proxyStatus,
      runtime: {
        requested_channel: browserRuntime.requested_channel,
        resolved_channel: browserRuntime.resolved_channel,
        executable_path: browserRuntime.executable_path,
        version: browserRuntime.version,
        driver: browserRuntime.driver,
      },
    })
    eprint("eager hub browser launched; holding")
    await new Promise(() => {})
    return
  }
  for await (const record of boundedJsonLines(process.stdin)) {
    if (record.error) {
      eprint(record.error)
      err(null, -32600, record.error)
      continue
    }
    const trimmed = record.line.trim()
    if (!trimmed) continue
    let message
    try {
      message = JSON.parse(trimmed)
    } catch (error) {
      eprint(`invalid JSON: ${error.message}`)
      err(null, -32700, "parse error")
      continue
    }

    const messages = Array.isArray(message) ? message : [message]
    if (messages.length === 0) {
      err(null, -32600, "request batch must not be empty")
      continue
    }
    if (messages.length > MAX_BATCH_REQUESTS) {
      err(null, -32600, `request batch exceeds ${MAX_BATCH_REQUESTS} items`)
      continue
    }
    for (const item of messages) {
      const envelopeError = requestEnvelopeError(item)
      if (envelopeError) {
        err(item && typeof item === "object" && !Array.isArray(item) ? (item.id ?? null) : null, -32600, envelopeError)
        continue
      }
      await handleRequest(item)
    }
  }

  await closeBrowser()
  eprint("stdio closed")
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    await main()
  } catch (error) {
    await closeBrowser().catch((cleanupError) => {
      eprint(`browser cleanup failed: ${cleanupError.message || String(cleanupError)}`)
    })
    eprint(`fatal: ${error.stack || error.message || String(error)}`)
    process.exitCode = 1
  }
}
