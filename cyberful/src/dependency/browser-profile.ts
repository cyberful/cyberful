// ── Browser Profile Identity ────────────────────────────────────────
// Defines five target identities plus one isolated web-research identity shared
// by manual pre-authentication and phase gateways.
// → cyberful/src/bootstrap-browser.ts — provisions stable browser state defaults.
// → cyberful/src/subsystem/gateway/server.ts — routes browser tools by profile.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────────

import os from "node:os"
import path from "node:path"

export const TARGET_BROWSER_PROFILE_IDS = [1, 2, 3, 4, 5] as const
export const SEARCH_BROWSER_PROFILE_ID = "search" as const
export const BROWSER_PROFILE_IDS = [...TARGET_BROWSER_PROFILE_IDS, SEARCH_BROWSER_PROFILE_ID] as const

export type TargetBrowserProfileId = (typeof TARGET_BROWSER_PROFILE_IDS)[number]
export type BrowserProfileId = TargetBrowserProfileId | typeof SEARCH_BROWSER_PROFILE_ID

// ── Forked agent-browser Owns Chrome Compatibility ─────────────────
// Profile paths are stable host-owned state. The Cyberful agent-browser fork
// launches Chrome directly and applies its hardened CDP behavior internally.
// Manual and phase launchers supply this identity through host-owned environment;
// browser tools cannot replace the directory or its lifecycle owner.
// ─────────────────────────────────────────────────────────────────────
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
  const override = configuredPath(
    env,
    profile === SEARCH_BROWSER_PROFILE_ID
      ? "CYBER_BROWSER_USER_DATA_DIR_SEARCH"
      : `CYBER_BROWSER_USER_DATA_DIR_${profile}`,
  )
  if (override) return override
  if (profile === 1) {
    const legacy = configuredPath(env, "CYBER_BROWSER_USER_DATA_DIR")
    if (legacy) return legacy
  }
  const directory = profile === SEARCH_BROWSER_PROFILE_ID ? "search" : profile === 1 ? "cyberful" : `cyberful-${profile}`
  return path.join(browserHome(homeDirectory), "profiles", directory)
}

export function browserArtifactsDir(
  profile: BrowserProfileId,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  homeDirectory = os.homedir(),
): string {
  const override = configuredPath(
    env,
    profile === SEARCH_BROWSER_PROFILE_ID
      ? "CYBER_BROWSER_ARTIFACTS_DIR_SEARCH"
      : `CYBER_BROWSER_ARTIFACTS_DIR_${profile}`,
  )
  if (override) return override
  if (profile === 1) {
    const legacy = configuredPath(env, "CYBER_BROWSER_ARTIFACTS_DIR")
    if (legacy) return legacy
  }
  return path.join(
    browserHome(homeDirectory),
    "artifacts",
    profile === SEARCH_BROWSER_PROFILE_ID ? "search" : `profile-${profile}`,
  )
}

// ── Manual Seeding Always Owns Its Persistent Browser ───────────────
// Profile seeding is a headed, human-owned launch rather than a phase attachment.
// Host-private CDP and shared-attestation modes must not leak from a surrounding
// environment or the command could connect to another process and seed the wrong
// identity. The persistent Chrome directory is the sole authentication store;
// agent-browser restore state is scrubbed because its periodic storage capture
// creates visible temporary tabs while a human is using the headed browser. The
// host fixes Chrome's native last-session restoration so session cookies survive
// the next clean startup without introducing a second credential store.
// ─────────────────────────────────────────────────────────────────────
export function manualBrowserProfileEnv(
  profile: TargetBrowserProfileId,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  homeDirectory = os.homedir(),
): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  for (const key of [
    "CYBER_BROWSER_CDP_ENDPOINT",
    "CYBER_BROWSER_OWN_TAB",
    "CYBER_BROWSER_SHARED_ATTESTATION",
    "AGENT_BROWSER_CDP",
    "AGENT_BROWSER_AUTO_CONNECT",
    "AGENT_BROWSER_ARGS",
    "AGENT_BROWSER_CONFIG",
    "AGENT_BROWSER_ENGINE",
    "AGENT_BROWSER_EXECUTABLE_PATH",
    "AGENT_BROWSER_EXTENSIONS",
    "AGENT_BROWSER_INIT_SCRIPTS",
    "AGENT_BROWSER_PLUGINS",
    "AGENT_BROWSER_PASSIVE",
    "AGENT_BROWSER_PROVIDER",
    "AGENT_BROWSER_PROXY",
    "AGENT_BROWSER_PROXY_BYPASS",
    "AGENT_BROWSER_AUTOSAVE_INTERVAL_MS",
    "AGENT_BROWSER_RESTORE",
    "AGENT_BROWSER_RESTORE_SAVE",
    "AGENT_BROWSER_SESSION_NAME",
    "AGENT_BROWSER_SOCKET_DIR",
    "AGENT_BROWSER_STATE",
  ])
    delete inherited[key]
  const artifacts = browserArtifactsDir(profile, env, homeDirectory)
  const executable = configuredPath(env, "CYBER_BROWSER_CHROME_EXECUTABLE")
  return {
    ...inherited,
    CYBER_BROWSER_USER_DATA_DIR: browserProfileDir(profile, env, homeDirectory),
    CYBER_BROWSER_ARTIFACTS_DIR: artifacts,
    CYBER_BROWSER_PROFILE_ID: String(profile),
    CYBER_BROWSER_HEADLESS: "false",
    AGENT_BROWSER_PROFILE: browserProfileDir(profile, env, homeDirectory),
    ...(executable ? { AGENT_BROWSER_EXECUTABLE_PATH: executable } : {}),
    AGENT_BROWSER_DOWNLOAD_PATH: artifacts,
    AGENT_BROWSER_SCREENSHOT_DIR: artifacts,
    AGENT_BROWSER_SESSION: `cyberful-manual-${profile}`,
    AGENT_BROWSER_NAMESPACE: `cyberful-manual-${profile}`,
    AGENT_BROWSER_HEADED: "1",
    AGENT_BROWSER_PASSIVE: "1",
    AGENT_BROWSER_ARGS: "--restore-last-session",
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
    AGENT_BROWSER_SOCKET_DIR: path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", `cyb-ab-manual-${profile}`),
  }
}

export function isBrowserProfileId(value: unknown): value is BrowserProfileId {
  return value === SEARCH_BROWSER_PROFILE_ID || isTargetBrowserProfileId(value)
}

export function isTargetBrowserProfileId(value: unknown): value is TargetBrowserProfileId {
  return typeof value === "number" && TARGET_BROWSER_PROFILE_IDS.some((profile) => profile === value)
}

export * as BrowserProfile from "./browser-profile"
