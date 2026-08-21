// ── agent-browser Runtime Preflight ───────────────────────────────────
// Verifies the pinned native executable and provisions Chrome for Testing with
// bounded process ownership before the TUI starts; failures remain degraded.
// → cyberful/src/bootstrap-browser.ts — embeds the platform-native package.
// @docs/runtimes/browser.md
// ────────────────────────────────────────────────────────────────────

import { mkdir, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as Log from "@/util/log"
import { errorMessage } from "@/util/error"
import { Process } from "@/util/process"
import {
  cyberAgentBrowserCommand,
  cyberCaptchaPluginCommand,
  shouldEnableCyberBrowserMcp,
} from "./config"

const log = Log.create({ service: "browser-preflight" })
const AGENT_BROWSER_VERSION = "0.34.0-cyberful.3"
const INSTALL_TIMEOUT_MS = 10 * 60 * 1_000
const INSTALL_KILL_GRACE_MS = 1_000
const MAX_INSTALL_OUTPUT_BYTES = 256 * 1024

const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR
const paint = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = (text: string) => paint("2", text)
const green = (text: string) => paint("32", text)
const red = (text: string) => paint("31", text)
const yellow = (text: string) => paint("33", text)

function line(text = "") {
  process.stderr.write(text + "\n")
}

function isNodeErrorCode(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

async function managedChromeInstalled(): Promise<boolean> {
  const directory = path.join(os.homedir(), ".agent-browser", "browsers")
  try {
    return (await readdir(directory)).some((entry) => entry.startsWith("chrome-"))
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT")) return false
    throw new Error(`Could not inspect agent-browser Chrome directory: ${directory}`, { cause })
  }
}

function systemChromeInstalled(): boolean {
  if (process.platform === "darwin")
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ].some((candidate) => Bun.file(candidate).size > 0)
  if (process.platform === "win32")
    return [
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe") : "",
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    ].some((candidate) => Boolean(candidate) && Bun.file(candidate).size > 0)
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].some((name) => Bun.which(name))
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

// ── Provisioning Owns Its Child Until Reaped ────────────────────────
// Chrome installation is bounded by time and retained output. Abort escalates
// through the shared Process helper and still reaps the child before returning.
// The command is the pinned agent-browser executable, never a package-manager
// shim, so preflight cannot silently resolve a different runtime release.
// ─────────────────────────────────────────────────────────────────────
export async function installChromium(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
  options?: ChromiumInstallOptions,
) {
  const timeoutMs = options?.timeoutMs ?? INSTALL_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("Chromium install timeout must be a positive safe integer")
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
    if (cause instanceof Process.RunFailedError)
      return { code: cause.code, stdout: cause.stdout, stderr: cause.stderr }
    throw new Error("Could not execute Chromium installer", { cause })
  } finally {
    clearTimeout(timeout)
  }
}

export async function runBrowserPreflight(): Promise<void> {
  if (shouldSkipBrowserPreflight() || !shouldEnableCyberBrowserMcp()) return

  line()
  line(dim("Cyberful preflight — agent-browser"))
  const command = cyberAgentBrowserCommand()
  const profile = process.env.CYBER_BROWSER_USER_DATA_DIR
  if (profile)
    await mkdir(profile, { recursive: true }).catch((cause) =>
      log.warn("preflight: could not create browser profile dir", { profile, error: errorMessage(cause), cause }),
    )

  const version = await Process.run([...command, "--version"], {
    abort: AbortSignal.timeout(10_000),
    timeout: 1_000,
    nothrow: true,
    maxOutputBytes: 64 * 1024,
  }).catch((cause) => {
    log.warn("preflight: agent-browser version probe failed", { error: errorMessage(cause), cause })
    return undefined
  })
  if (!version || version.code !== 0 || version.stdout.toString("utf8").trim() !== `agent-browser ${AGENT_BROWSER_VERSION}`) {
    line(`  ${red("✗")} agent-browser ${AGENT_BROWSER_VERSION} is unavailable`)
    line(dim("    In dev, run: npm install --prefix mcps"))
    line()
    return
  }

  const captchaCommand = cyberCaptchaPluginCommand()
  const captchaVersion = captchaCommand
    ? await Process.run([captchaCommand, "--version"], {
        abort: AbortSignal.timeout(10_000),
        timeout: 1_000,
        nothrow: true,
        maxOutputBytes: 64 * 1024,
      }).catch((cause) => {
        log.warn("preflight: CAPTCHA plugin version probe failed", { error: errorMessage(cause), cause })
        return undefined
      })
    : undefined
  if (
    !captchaVersion ||
    captchaVersion.code !== 0 ||
    !/agent-browser-plugin-captcha\s+0\.1\.0\b/u.test(captchaVersion.stdout.toString("utf8"))
  ) {
    line(`  ${red("✗")} first-party agent-browser CAPTCHA plugin 0.1.0 is unavailable`)
    line(dim("    Browser profiles require the bundled plugin; reinstall Cyberful or restore mcps/browser."))
    line()
    return
  }

  const chromeReady = await managedChromeInstalled().catch((cause) => {
    log.warn("preflight: Chrome cache inspection failed", { error: errorMessage(cause), cause })
    return false
  })
  if (chromeReady || systemChromeInstalled()) {
    line(`  ${green("✓")} agent-browser ${AGENT_BROWSER_VERSION}, CAPTCHA plugin 0.1.0, and Chrome ready`)
    line()
    return
  }

  line(`  ${yellow("⏳")} Chrome not found — installing Chrome for Testing…`)
  const install = await installChromium([...command, "install"], { ...process.env }).catch((cause) => {
    log.warn("preflight: agent-browser install failed", { error: errorMessage(cause), cause })
    return undefined
  })
  if (!install || install.code !== 0) {
    line(`  ${red("✗")} Chrome download failed${install ? dim(` (exit ${install.code})`) : ""}`)
    line(dim("    The agent_browser_* tools will be unavailable until it succeeds. Relaunch to retry."))
    if (install)
      log.warn("preflight: agent-browser install failed", {
        code: install.code,
        stderr: install.stderr.toString("utf8").trim(),
      })
    line()
    return
  }
  line(`  ${green("✓")} agent-browser ${AGENT_BROWSER_VERSION}, CAPTCHA plugin 0.1.0, and Chrome ready`)
  line()
}

export * as BrowserPreflight from "./browser-preflight"
