// ── Browser Launch Isolation Contract ───────────────────────────────
// Verifies every launch channel disables background services and that profile
// preparation preserves unrelated user preferences while applying safe defaults.
// → mcps/browser/browser_launch_policy.mjs — owns the enforced launch policy.
// ────────────────────────────────────────────────────────────────────

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import {
  BACKGROUND_NETWORKING_DISABLED_ARGS,
  PATCHRIGHT_DISABLED_FEATURES_ARG,
  prepareBackgroundNetworkingProfile,
} from "./browser_launch_policy.mjs"

describe("browser launch network policy", () => {
  test("disables browser-owned background traffic for every launch channel", () => {
    const requiredSwitches = [
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
      "--metrics-recording-only",
      "--no-pings",
      "--safebrowsing-disable-auto-update",
    ]
    for (const requiredSwitch of requiredSwitches) expect(BACKGROUND_NETWORKING_DISABLED_ARGS).toContain(requiredSwitch)
    expect(new Set(BACKGROUND_NETWORKING_DISABLED_ARGS).size).toBe(BACKGROUND_NETWORKING_DISABLED_ARGS.length)
    const featureArguments = BACKGROUND_NETWORKING_DISABLED_ARGS.filter((value) =>
      value.startsWith("--disable-features="),
    )
    expect(featureArguments).toHaveLength(1)
    const disabledFeatures = new Set(featureArguments[0]?.slice("--disable-features=".length).split(","))
    for (const feature of PATCHRIGHT_DISABLED_FEATURES_ARG.slice("--disable-features=".length).split(",")) {
      expect(disabledFeatures.has(feature)).toBe(true)
    }
    for (const backgroundFeature of ["NetworkTimeServiceQuerying", "AimServerRequestOnStartupEnabled"]) {
      expect(disabledFeatures.has(backgroundFeature)).toBe(true)
    }
  })

  test("disables only browser account services in the persistent Cyberful profile", () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-browser-policy-"))
    const preferencesPath = path.join(userDataDir, "Default", "Preferences")
    fs.mkdirSync(path.dirname(preferencesPath), { recursive: true })
    fs.writeFileSync(
      preferencesPath,
      JSON.stringify({
        profile: { name: "Cyberful" },
        signin: { allowed: true, existing_setting: "preserved" },
        target_session_marker: "preserved",
      }),
    )

    try {
      expect(prepareBackgroundNetworkingProfile(userDataDir)).toBe(preferencesPath)
      expect(JSON.parse(fs.readFileSync(preferencesPath, "utf8"))).toEqual({
        profile: { name: "Cyberful" },
        signin: {
          allowed: false,
          allowed_on_next_startup: false,
          existing_setting: "preserved",
        },
        omnibox: { ai_mode_settings: 1 },
        target_session_marker: "preserved",
      })
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  test("fails closed when persistent profile preferences are malformed or unsafe", () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-browser-policy-invalid-"))
    const preferencesPath = path.join(userDataDir, "Default", "Preferences")
    const externalPreferences = path.join(userDataDir, "external-preferences.json")
    fs.mkdirSync(path.dirname(preferencesPath), { recursive: true })

    try {
      fs.writeFileSync(preferencesPath, "not-json")
      expect(() => prepareBackgroundNetworkingProfile(userDataDir)).toThrow("not valid JSON")

      fs.writeFileSync(preferencesPath, " ".repeat(4 * 1024 * 1024 + 1))
      expect(() => prepareBackgroundNetworkingProfile(userDataDir)).toThrow("safe file limit")

      fs.rmSync(preferencesPath)
      fs.writeFileSync(externalPreferences, "{}")
      fs.symlinkSync(externalPreferences, preferencesPath)
      expect(() => prepareBackgroundNetworkingProfile(userDataDir)).toThrow("cannot be opened safely")
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  })
})
