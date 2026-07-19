// ── Browser Profile Identity Tests ──────────────────────────────────
// Protects stable multi-profile paths and legacy profile-one override behavior
// used by both manual pre-authentication and autonomous browser routing.
// → cyberful/src/dependency/browser-profile.ts — resolves the tested identities.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { BrowserProfile } from "./browser-profile"

describe("browser profile identity", () => {
  test("assigns five distinct stable profile and artifact directories", () => {
    const env = {}
    const profiles = BrowserProfile.BROWSER_PROFILE_IDS.map((profile) =>
      BrowserProfile.browserProfileDir(profile, env, "/home/tester"),
    )
    const artifacts = BrowserProfile.BROWSER_PROFILE_IDS.map((profile) =>
      BrowserProfile.browserArtifactsDir(profile, env, "/home/tester"),
    )

    expect(new Set(profiles).size).toBe(5)
    expect(new Set(artifacts).size).toBe(5)
    expect(profiles[0]).toBe("/home/tester/.cyberful/browser/profiles/cyberful")
    expect(profiles[4]).toBe("/home/tester/.cyberful/browser/profiles/cyberful-5")
  })

  test("prefers numbered overrides while preserving the profile-one legacy override", () => {
    expect(
      BrowserProfile.browserProfileDir(
        1,
        {
          CYBER_BROWSER_USER_DATA_DIR: "/legacy/one",
          CYBER_BROWSER_USER_DATA_DIR_1: "/numbered/one",
        },
        "/unused",
      ),
    ).toBe("/numbered/one")
    expect(BrowserProfile.browserProfileDir(1, { CYBER_BROWSER_USER_DATA_DIR: "/legacy/one" }, "/unused")).toBe(
      "/legacy/one",
    )
    expect(BrowserProfile.browserProfileDir(2, { CYBER_BROWSER_USER_DATA_DIR: "/legacy/one" }, "/home/tester")).toBe(
      "/home/tester/.cyberful/browser/profiles/cyberful-2",
    )
  })

  test("builds a headed owned launch for the selected manual profile", () => {
    const env = BrowserProfile.manualBrowserProfileEnv(
      2,
      {
        PATH: "/usr/bin",
        CYBER_BROWSER_HEADLESS: "true",
        CYBER_BROWSER_USER_DATA_DIR_2: "/profiles/two",
        CYBER_BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222",
        CYBER_BROWSER_OWN_TAB: "1",
        CYBER_BROWSER_SHARED_ATTESTATION: "must-not-cross",
      },
      "/home/tester",
    )

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      CYBER_BROWSER_BROWSERS_PATH: "/home/tester/.cyberful/browser/.browsers",
      CYBER_BROWSER_USER_DATA_DIR: "/profiles/two",
      CYBER_BROWSER_PROFILE_ID: "2",
      CYBER_BROWSER_EAGER: "1",
      CYBER_BROWSER_HEADLESS: "false",
    })
    expect(env.CYBER_BROWSER_CDP_ENDPOINT).toBeUndefined()
    expect(env.CYBER_BROWSER_OWN_TAB).toBeUndefined()
    expect(env.CYBER_BROWSER_SHARED_ATTESTATION).toBeUndefined()
  })
})
