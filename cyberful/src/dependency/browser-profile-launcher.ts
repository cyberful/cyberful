// ── Manual Browser Profile Process Ownership ────────────────────────
// Starts one selected persistent identity through agent-browser's headed daemon
// and owns signal forwarding until the passive daemon releases its profile.
// → cyberful/src/dependency/browser-profile.ts — resolves isolated profile state.
// → cyberful/src/dependency/browser-preflight.ts — installs Chromium before launch.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────────

import { BrowserPreflight } from "./browser-preflight"
import { cyberAgentBrowserCommand, cyberCaptchaPluginCommand } from "./config"
import { BrowserProfile, type TargetBrowserProfileId } from "./browser-profile"

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

export interface BrowserProfileLaunchOptions {
  readonly write?: (message: string) => void
  readonly pollIntervalMs?: number
}

async function browserSessionActive(command: readonly string[], environment: Record<string, string>): Promise<boolean> {
  const child = Bun.spawn([...command, "session", "info", "--json"], {
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(stderr.trim() || `agent-browser session info exited with code ${code}`)
  let result: unknown
  try {
    result = JSON.parse(stdout)
  } catch (cause) {
    throw new Error("agent-browser session info returned malformed JSON", { cause })
  }
  if (typeof result !== "object" || result === null || !("data" in result))
    throw new Error("agent-browser session info returned a malformed result")
  const data = result.data
  if (typeof data !== "object" || data === null || !("active" in data) || typeof data.active !== "boolean")
    throw new Error("agent-browser session info omitted daemon activity")
  return data.active
}

async function closeBrowserSession(command: readonly string[], environment: Record<string, string>): Promise<void> {
  const child = Bun.spawn([...command, "close"], {
    env: environment,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  await child.exited
}

// ── The CLI Seeds One Headed Daemon Session ─────────────────────────
// The fork's passive mode launches headed Chrome without attaching DevTools to
// page targets, so restored tabs remain untouched and Google login receives a
// normal interactive browser surface. The startup command exits after creating
// the daemon, so Cyberful polls read-only session status until the fork observes
// that Chrome closed and exits its passive daemon. Signals close an already-open
// session; no command is replayed after an uncertain result. The later phase uses
// its own host-owned daemon session and namespace.
// ─────────────────────────────────────────────────────────────────────
export async function launchBrowserProfile(
  profile: TargetBrowserProfileId,
  options: BrowserProfileLaunchOptions = {},
): Promise<number> {
  await BrowserPreflight.runBrowserPreflight()

  const write = options.write ?? ((message: string) => process.stderr.write(message))
  const profileDirectory = BrowserProfile.browserProfileDir(profile)
  const captchaPlugin = cyberCaptchaPluginCommand()
  if (!captchaPlugin) throw new Error("first-party agent-browser CAPTCHA plugin is unavailable")
  const command = cyberAgentBrowserCommand()
  const environment = {
    ...BrowserProfile.manualBrowserProfileEnv(profile),
    AGENT_BROWSER_PLUGINS: JSON.stringify([
      {
        name: "captcha",
        command: captchaPlugin,
        capabilities: ["command.run", "captcha.solve"],
      },
    ]),
    ...(process.env.CYBER_BROWSER_BUN_REENTRY === "1" ? { BUN_BE_BUN: "1" } : {}),
  }
  write(`Opening Cyberful browser profile ${profile}: ${profileDirectory}\n`)
  write("Sign in to the authorized target, then close the browser before starting Cyberful.\n")

  const child = Bun.spawn([...command, "open", "--headed"], {
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  let monitoring = false
  let interrupted = false
  let shutdown: Promise<void> | undefined
  const forwarders = new Map(
    FORWARDED_SIGNALS.map(
      (signal) =>
        [
          signal,
          () => {
            interrupted = true
            try {
              child.kill(signal)
            } catch {
              // The browser may already have released its profile lock and exited.
            }
            if (monitoring) void (shutdown ??= closeBrowserSession(command, environment))
          },
        ] as const,
    ),
  )

  forwarders.forEach((forward, signal) => process.on(signal, forward))
  try {
    const code = await child.exited
    if (code !== 0 || interrupted) return code
    monitoring = true
    const pollIntervalMs = options.pollIntervalMs ?? 250
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0)
      throw new RangeError("browser profile poll interval must be a positive safe integer")
    while (await browserSessionActive(command, environment)) await Bun.sleep(pollIntervalMs)
    return 0
  } finally {
    if (shutdown) await shutdown
    forwarders.forEach((forward, signal) => process.removeListener(signal, forward))
  }
}

export * as BrowserProfileLauncher from "./browser-profile-launcher"
