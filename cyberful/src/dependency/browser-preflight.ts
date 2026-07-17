// ── Browser Runtime Preflight ────────────────────────────────────
// Prepares the isolated browser profile and installs Chromium with bounded
// process ownership before the TUI takes the terminal; failures stay degraded.
// → cyberful/src/bootstrap-browser.ts — embeds the browser driver but not Chromium itself.
// → mcps/browser/bin/cyber-browser — launches the prepared isolated browser.
// ─────────────────────────────────────────────────────────────────
import { access, mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import * as Log from "@/util/log"
import { errorMessage } from "@/util/error"
import { Process } from "@/util/process"
import { cyberBrowserMcpCommand, shouldEnableCyberBrowserMcp } from "./config"

const log = Log.create({ service: "browser-preflight" })
const INSTALL_TIMEOUT_MS = 10 * 60 * 1_000
const INSTALL_KILL_GRACE_MS = 1_000
const MAX_INSTALL_OUTPUT_BYTES = 256 * 1024

const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR
const paint = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = (t: string) => paint("2", t)
const green = (t: string) => paint("32", t)
const yellow = (t: string) => paint("33", t)
const red = (t: string) => paint("31", t)

function line(text = "") {
  process.stderr.write(text + "\n")
}

function isNodeErrorCode(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

async function chromiumInstalled(browsersPath: string): Promise<boolean> {
  try {
    return (await readdir(browsersPath)).some((entry) => entry.startsWith("chromium"))
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT")) return false
    throw new Error(`Could not inspect browser installation directory: ${browsersPath}`, { cause })
  }
}

async function fileExists(file: string) {
  try {
    await access(file)
    return true
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT")) return false
    throw new Error(`Could not inspect browser dependency: ${file}`, { cause })
  }
}

export function shouldSkipBrowserPreflight(env: Readonly<NodeJS.ProcessEnv> = process.env) {
  const value = env.CYBERFUL_SKIP_BROWSER_PREFLIGHT?.trim().toLowerCase()
  if (value === undefined) return false
  if (value === "1" || value === "true" || value === "yes") return true
  if (value === "0" || value === "false" || value === "no") return false
  throw new Error("CYBERFUL_SKIP_BROWSER_PREFLIGHT must be one of: 1, true, yes, 0, false, no")
}

export interface ChromiumInstallOptions {
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
}

// ── Provisioning Owns Its Child Until Reaped ────────────────────
// Chromium installation can hang on network or package-manager failures before
// the TUI exists. The preflight captures only a fixed diagnostic budget and
// cancels at a fixed deadline; cancellation escalates to KILL and still waits
// for child exit and pipe closure. The caller may then degrade browser support
// without leaving a hidden installer or unbounded terminal output behind.
// ─────────────────────────────────────────────────────────────────
export async function installChromium(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
  options?: ChromiumInstallOptions,
) {
  const timeoutMs = options?.timeoutMs ?? INSTALL_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Chromium install timeout must be a positive safe integer")
  }
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error(`Chromium install timed out after ${timeoutMs}ms`)),
    timeoutMs,
  )
  timeout.unref()
  try {
    const result = await Process.run([...command], {
      abort: controller.signal,
      env,
      maxOutputBytes: options?.maxOutputBytes ?? MAX_INSTALL_OUTPUT_BYTES,
      timeout: INSTALL_KILL_GRACE_MS,
    })
    if (!controller.signal.aborted) return result
    const reason = controller.signal.reason
    throw reason instanceof Error ? reason : new Error("Chromium install timed out")
  } catch (cause) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      throw new Error(reason instanceof Error ? reason.message : "Chromium install timed out", { cause })
    }
    if (cause instanceof Process.RunFailedError) {
      return { code: cause.code, stdout: cause.stdout, stderr: cause.stderr }
    }
    throw new Error("Could not execute Chromium installer", { cause })
  } finally {
    clearTimeout(timeout)
  }
}

export async function runBrowserPreflight(): Promise<void> {
  if (shouldSkipBrowserPreflight()) return
  if (!shouldEnableCyberBrowserMcp()) return

  line()
  line(dim("Cyberful preflight — browser"))

  // The launcher is <root>/browser/bin/cyber-browser; patchright-core lives at <root>/node_modules.
  const launcher = cyberBrowserMcpCommand()[0]
  const pkgRoot = path.resolve(path.dirname(launcher), "..", "..")
  const browsersPath = process.env.CYBER_BROWSER_BROWSERS_PATH || path.join(pkgRoot, "browser", ".browsers")

  // Dedicated persistent profile for cyberful's browser (kept out of any personal Chrome profile).
  const profile = process.env.CYBER_BROWSER_USER_DATA_DIR
  if (profile) {
    try {
      await mkdir(profile, { recursive: true })
    } catch (cause) {
      log.warn("preflight: could not create browser profile dir", { profile, error: errorMessage(cause), cause })
    }
  }

  // Real Google Chrome uses the system install — no Chromium to fetch. (chromium/auto need the bundled one.)
  if ((process.env.CYBER_BROWSER_CHANNEL ?? "chromium") === "chrome") {
    line(`  ${green("✓")} using system Google Chrome ${dim("(CYBER_BROWSER_CHANNEL=chrome)")}`)
    line()
    return
  }

  let installed
  try {
    installed = await chromiumInstalled(browsersPath)
  } catch (cause) {
    line(`  ${red("✗")} Chromium cache could not be inspected`)
    log.warn("preflight: chromium cache inspection failed", { error: errorMessage(cause), cause })
    line()
    return
  }
  if (installed) {
    line(`  ${green("✓")} Chromium ready ${dim(`(${browsersPath})`)}`)
    line()
    return
  }

  // ── Browser Provisioning Is A Degraded Capability ───────────────
  // The browser driver is embedded, but its large Chromium payload is acquired
  // on first use and can fail for reasons outside Cyberful's control. Installer
  // output remains inside a fixed capture budget before the TUI mounts. Failure
  // is reported with its retained cause and retried on the next launch; it must
  // not prevent non-browser security workflows from starting.
  // ─────────────────────────────────────────────────────────────────
  const cli = path.join(pkgRoot, "node_modules", "patchright-core", "cli.js")
  let hasInstaller
  try {
    hasInstaller = await fileExists(cli)
  } catch (cause) {
    line(`  ${red("✗")} browser driver could not be inspected`)
    log.warn("preflight: browser driver inspection failed", { error: errorMessage(cause), cause })
    line()
    return
  }
  if (!hasInstaller) {
    line(`  ${yellow("!")} browser driver not provisioned ${dim(`(${cli})`)}`)
    line(dim("    In dev, run: cd mcps && npm run browser:install"))
    line()
    log.warn("preflight: patchright-core cli not found", { cli })
    return
  }
  line(`  ${yellow("⏳")} Chromium not found — downloading now (first run, ~150 MB)…`)
  let install
  try {
    install = await installChromium(["node", cli, "install", "chromium"], {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: browsersPath,
      CYBER_BROWSER_BROWSERS_PATH: browsersPath,
    })
  } catch (cause) {
    line(`  ${red("✗")} Chromium download failed`)
    line(dim("    The browser_* tools will be unavailable until it succeeds. Relaunch to retry."))
    log.warn("preflight: chromium install failed", { error: errorMessage(cause), cause })
    line()
    return
  }
  if (install.code !== 0) {
    line(`  ${red("✗")} Chromium download failed ${dim(`(exit ${install.code})`)}`)
    line(dim("    The browser_* tools will be unavailable until it succeeds. Relaunch to retry."))
    log.warn("preflight: chromium install failed", {
      code: install.code,
      stderr: install.stderr.toString("utf8").trim(),
    })
    line()
    return
  }
  line(`  ${green("✓")} Chromium ready ${dim(`(${browsersPath})`)}`)
  line()
}

export * as BrowserPreflight from "./browser-preflight"
