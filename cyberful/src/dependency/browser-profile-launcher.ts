// ── Manual Browser Profile Process Ownership ────────────────────────
// Starts one selected persistent browser identity, keeps the terminal attached,
// and owns signal forwarding until the embedded or source browser process exits.
// → cyberful/src/dependency/browser-profile.ts — resolves isolated profile state.
// → cyberful/src/dependency/browser-preflight.ts — installs Chromium before launch.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────────

import { BrowserPreflight } from "./browser-preflight"
import { cyberBrowserMcpCommand } from "./config"
import { BrowserProfile, type BrowserProfileId } from "./browser-profile"

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

export interface BrowserProfileLaunchOptions {
  readonly write?: (message: string) => void
}

// ── The CLI Owns The Interactive Browser Lifetime ───────────────────
// Eager browser mode opens the persistent context and intentionally waits while
// its Chromium window remains alive. The CLI therefore inherits the terminal,
// forwards every ordinary termination signal, and awaits the child after normal
// close or interruption. Signal listeners are removed only after that process is
// reaped, preventing a completed profile session from affecting later CLI work.
// ─────────────────────────────────────────────────────────────────────
export async function launchBrowserProfile(
  profile: BrowserProfileId,
  options: BrowserProfileLaunchOptions = {},
): Promise<number> {
  await BrowserPreflight.runBrowserPreflight()

  const write = options.write ?? ((message: string) => process.stderr.write(message))
  const profileDirectory = BrowserProfile.browserProfileDir(profile)
  write(`Opening Cyberful browser profile ${profile}: ${profileDirectory}\n`)
  write("Sign in to the authorized target, then close the browser before starting Cyberful.\n")

  const child = Bun.spawn(cyberBrowserMcpCommand(), {
    env: {
      ...BrowserProfile.manualBrowserProfileEnv(profile),
      ...(process.env.CYBER_BROWSER_BUN_REENTRY === "1" ? { BUN_BE_BUN: "1" } : {}),
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const forwarders = new Map(
    FORWARDED_SIGNALS.map(
      (signal) =>
        [
          signal,
          () => {
            try {
              child.kill(signal)
            } catch {
              // The browser may already have released its profile lock and exited.
            }
          },
        ] as const,
    ),
  )

  forwarders.forEach((forward, signal) => process.on(signal, forward))
  try {
    return await child.exited
  } finally {
    forwarders.forEach((forward, signal) => process.removeListener(signal, forward))
  }
}

export * as BrowserProfileLauncher from "./browser-profile-launcher"
