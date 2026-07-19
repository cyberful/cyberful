// ── Browser Profile Identity ────────────────────────────────────────
// Defines the five stable browser identities shared by manual pre-authentication
// and phase gateways, including legacy profile-one environment compatibility.
// → cyberful/src/bootstrap-browser.ts — provisions stable browser state defaults.
// → cyberful/src/subsystem/gateway/server.ts — routes browser tools by profile.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────────

import os from "node:os"
import path from "node:path"

export const BROWSER_PROFILE_IDS = [1, 2, 3, 4, 5] as const

export type BrowserProfileId = (typeof BROWSER_PROFILE_IDS)[number]

export function browserHome(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, ".cyberful", "browser")
}

function configuredPath(env: Readonly<NodeJS.ProcessEnv>, name: string): string | undefined {
  const value = env[name]?.trim()
  return value || undefined
}

// ── Profile One Preserves Existing Authenticated State ──────────────
// Cyberful historically stored its sole installed profile under `cyberful`, so
// profile one retains that location and the unsuffixed environment override.
// Numbered overrides take precedence for a uniform five-profile contract, while
// profiles two through five receive distinct stable directories by default.
// This prevents an upgrade from discarding profile-one logins or co-locating two
// identities in the same Chromium storage and lock boundary.
// ─────────────────────────────────────────────────────────────────────
export function browserProfileDir(
  profile: BrowserProfileId,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  homeDirectory = os.homedir(),
): string {
  const numbered = configuredPath(env, `CYBER_BROWSER_USER_DATA_DIR_${profile}`)
  if (numbered) return numbered
  if (profile === 1) {
    const legacy = configuredPath(env, "CYBER_BROWSER_USER_DATA_DIR")
    if (legacy) return legacy
  }
  const directory = profile === 1 ? "cyberful" : `cyberful-${profile}`
  return path.join(browserHome(homeDirectory), "profiles", directory)
}

export function browserArtifactsDir(
  profile: BrowserProfileId,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  homeDirectory = os.homedir(),
): string {
  const numbered = configuredPath(env, `CYBER_BROWSER_ARTIFACTS_DIR_${profile}`)
  if (numbered) return numbered
  if (profile === 1) {
    const legacy = configuredPath(env, "CYBER_BROWSER_ARTIFACTS_DIR")
    if (legacy) return legacy
  }
  return path.join(browserHome(homeDirectory), "artifacts", `profile-${profile}`)
}

// ── Manual Seeding Always Owns Its Persistent Browser ───────────────
// Profile seeding is a headed, human-owned launch rather than a phase attachment.
// Host-private CDP and shared-attestation modes must not leak from a surrounding
// environment or the command could connect to another process and seed the wrong
// identity. Other documented browser policy remains inherited, while cache,
// profile identity, eager lifetime, and headed mode are fixed for this boundary.
// ─────────────────────────────────────────────────────────────────────
export function manualBrowserProfileEnv(
  profile: BrowserProfileId,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  homeDirectory = os.homedir(),
): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !["CYBER_BROWSER_CDP_ENDPOINT", "CYBER_BROWSER_OWN_TAB", "CYBER_BROWSER_SHARED_ATTESTATION"].includes(entry[0]),
    ),
  )
  return {
    ...inherited,
    CYBER_BROWSER_BROWSERS_PATH:
      configuredPath(env, "CYBER_BROWSER_BROWSERS_PATH") ?? path.join(browserHome(homeDirectory), ".browsers"),
    CYBER_BROWSER_USER_DATA_DIR: browserProfileDir(profile, env, homeDirectory),
    CYBER_BROWSER_PROFILE_ID: String(profile),
    CYBER_BROWSER_EAGER: "1",
    CYBER_BROWSER_HEADLESS: "false",
  }
}

export function isBrowserProfileId(value: unknown): value is BrowserProfileId {
  return typeof value === "number" && BROWSER_PROFILE_IDS.some((profile) => profile === value)
}

export * as BrowserProfile from "./browser-profile"
