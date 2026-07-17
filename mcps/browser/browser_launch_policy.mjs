// ── Browser Background-Network Policy ───────────────────────────────
// Builds the launch arguments and profile preferences that stop Chromium-owned
// services from contacting vendors before an agent navigates to an in-scope target.
// Patchright's complete disable-features value remains one argument because
// Chromium honors only its final occurrence and would otherwise re-enable defaults.
// → mcps/browser/browser_mcp.mjs — applies the policy to every browser launch.
// ────────────────────────────────────────────────────────────────────

import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

const MAX_PROFILE_PREFERENCES_BYTES = 4 * 1024 * 1024

const PATCHRIGHT_DISABLED_BROWSER_FEATURES = Object.freeze([
  "AvoidUnnecessaryBeforeUnloadCheckSync",
  "BoundaryEventDispatchTracksNodeRemoval",
  "DestroyProfileOnBrowserClose",
  "DialMediaRouteProvider",
  "GlobalMediaControls",
  "HttpsUpgrades",
  "LensOverlay",
  "MediaRouter",
  "PaintHolding",
  "ThirdPartyStoragePartitioning",
  "Translate",
  "AutoDeElevate",
  "RenderDocument",
  "OptimizationHints",
  "msForceBrowserSignIn",
  "msEdgeUpdateLaunchServicesPreferredVersion",
])

const DISABLED_BROWSER_FEATURES = Object.freeze([
  ...PATCHRIGHT_DISABLED_BROWSER_FEATURES,
  "NetworkTimeServiceQuerying",
  "AimEnabled",
  "AimServerEligibilityEnabled",
  "AimServerRequestOnStartupEnabled",
  "AimServerRequestOnIdentityChangeEnabled",
])

export const PATCHRIGHT_DISABLED_FEATURES_ARG = `--disable-features=${PATCHRIGHT_DISABLED_BROWSER_FEATURES.join(",")}`

// One channel-independent list keeps the default Chromium and optional system Chrome on the same policy.
export const BACKGROUND_NETWORKING_DISABLED_ARGS = Object.freeze([
  "--disable-background-networking",
  "--disable-breakpad",
  "--disable-client-side-phishing-detection",
  "--disable-component-update",
  "--disable-crash-reporter",
  "--disable-default-apps",
  "--disable-domain-reliability",
  "--disable-search-engine-choice-screen",
  "--disable-sync",
  "--disable-translate",
  "--disallow-signin",
  "--gaia-url=http://cyberful.invalid",
  "--host-resolver-rules=MAP cyberful.invalid ~NOTFOUND",
  `--disable-features=${DISABLED_BROWSER_FEATURES.join(",")}`,
  "--metrics-recording-only",
  "--no-pings",
  "--safebrowsing-disable-auto-update",
])

function readProfilePreferences(preferencesPath) {
  let descriptor
  try {
    descriptor = fs.openSync(preferencesPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return {}
    throw new Error(`browser profile preferences cannot be opened safely: ${preferencesPath}`, { cause: error })
  }

  try {
    const metadata = fs.fstatSync(descriptor)
    if (!metadata.isFile() || metadata.size > MAX_PROFILE_PREFERENCES_BYTES) {
      throw new Error(`browser profile preferences exceed the safe file limit: ${preferencesPath}`)
    }
    try {
      return JSON.parse(fs.readFileSync(descriptor, { encoding: "utf8" }))
    } catch (error) {
      throw new Error(`browser profile preferences are not valid JSON: ${preferencesPath}`, { cause: error })
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

// ── Persistent Profiles Preserve Targets, Not Browser Accounts ───
// A dedicated profile may carry the target session a human intentionally
// established, but Chrome account reconciliation would create unrelated network
// traffic. Preferences are therefore read through a non-following descriptor,
// bounded before parsing, and rewritten atomically. Existing unrelated values
// and target cookies remain untouched while browser sign-in and AI mode stay off.
// ───────────────────────────────────────────────────────────────────
export function prepareBackgroundNetworkingProfile(userDataDir) {
  const profileDir = path.join(userDataDir, "Default")
  const preferencesPath = path.join(profileDir, "Preferences")
  fs.mkdirSync(profileDir, { recursive: true })

  const current = readProfilePreferences(preferencesPath)
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error(`browser profile preferences are not a JSON object: ${preferencesPath}`)
  }
  const signin =
    typeof current.signin === "object" && current.signin !== null && !Array.isArray(current.signin)
      ? current.signin
      : {}
  const omnibox =
    typeof current.omnibox === "object" && current.omnibox !== null && !Array.isArray(current.omnibox)
      ? current.omnibox
      : {}
  if (signin.allowed === false && signin.allowed_on_next_startup === false && omnibox.ai_mode_settings === 1) {
    return preferencesPath
  }

  const temporaryPath = `${preferencesPath}.cyberful-${process.pid}-${randomUUID()}.tmp`
  try {
    fs.writeFileSync(
      temporaryPath,
      JSON.stringify({
        ...current,
        signin: { ...signin, allowed: false, allowed_on_next_startup: false },
        omnibox: { ...omnibox, ai_mode_settings: 1 },
      }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    )
    fs.renameSync(temporaryPath, preferencesPath)
    return preferencesPath
  } finally {
    fs.rmSync(temporaryPath, { force: true })
  }
}
