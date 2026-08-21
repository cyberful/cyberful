// ── Browser Profile Identity Tests ──────────────────────────────────
// Protects stable multi-profile paths and legacy profile-one override behavior
// used by both manual pre-authentication and autonomous browser routing.
// → cyberful/src/dependency/browser-profile.ts — resolves the tested identities.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { BrowserProfile } from "./browser-profile"

describe("browser profile identity", () => {
  test("assigns five distinct stable profile and artifact directories", () => {
    const env = {}
    const profiles = BrowserProfile.TARGET_BROWSER_PROFILE_IDS.map((profile) =>
      BrowserProfile.browserProfileDir(profile, env, "/home/tester"),
    )
    const artifacts = BrowserProfile.TARGET_BROWSER_PROFILE_IDS.map((profile) =>
      BrowserProfile.browserArtifactsDir(profile, env, "/home/tester"),
    )

    expect(new Set(profiles).size).toBe(5)
    expect(new Set(artifacts).size).toBe(5)
    expect(profiles[0]).toBe("/home/tester/.cyberful/browser/profiles/cyberful")
    expect(profiles[4]).toBe("/home/tester/.cyberful/browser/profiles/cyberful-5")
  })

  test("keeps the web-research profile separate from every target identity", () => {
    expect(BrowserProfile.BROWSER_PROFILE_IDS).toEqual([1, 2, 3, 4, 5, "search"])
    expect(BrowserProfile.browserProfileDir("search", {}, "/home/tester")).toBe(
      "/home/tester/.cyberful/browser/profiles/search",
    )
    expect(BrowserProfile.browserArtifactsDir("search", {}, "/home/tester")).toBe(
      "/home/tester/.cyberful/browser/artifacts/search",
    )
    expect(
      BrowserProfile.browserProfileDir(
        "search",
        { CYBER_BROWSER_USER_DATA_DIR_SEARCH: "/profiles/research" },
        "/home/tester",
      ),
    ).toBe("/profiles/research")
    expect(
      BrowserProfile.browserArtifactsDir(
        "search",
        { CYBER_BROWSER_ARTIFACTS_DIR_SEARCH: "/artifacts/research" },
        "/home/tester",
      ),
    ).toBe("/artifacts/research")
    expect(BrowserProfile.isBrowserProfileId("search")).toBe(true)
    expect(BrowserProfile.isTargetBrowserProfileId("search")).toBe(false)
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
        CYBER_BROWSER_CHROME_EXECUTABLE: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        CYBER_BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222",
        CYBER_BROWSER_OWN_TAB: "1",
        CYBER_BROWSER_SHARED_ATTESTATION: "must-not-cross",
        AGENT_BROWSER_ARGS: "--proxy-server=http://untrusted.test",
        AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "30000",
        AGENT_BROWSER_RESTORE: "inherited-restore",
        AGENT_BROWSER_RESTORE_SAVE: "always",
      },
      "/home/tester",
    )

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      CYBER_BROWSER_USER_DATA_DIR: "/profiles/two",
      CYBER_BROWSER_ARTIFACTS_DIR: "/home/tester/.cyberful/browser/artifacts/profile-2",
      CYBER_BROWSER_PROFILE_ID: "2",
      CYBER_BROWSER_HEADLESS: "false",
      AGENT_BROWSER_PROFILE: "/profiles/two",
      AGENT_BROWSER_EXECUTABLE_PATH: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      AGENT_BROWSER_DOWNLOAD_PATH: "/home/tester/.cyberful/browser/artifacts/profile-2",
      AGENT_BROWSER_SCREENSHOT_DIR: "/home/tester/.cyberful/browser/artifacts/profile-2",
      AGENT_BROWSER_SESSION: "cyberful-manual-2",
      AGENT_BROWSER_NAMESPACE: "cyberful-manual-2",
      AGENT_BROWSER_HEADED: "1",
      AGENT_BROWSER_ARGS: "--restore-last-session",
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
      AGENT_BROWSER_SOCKET_DIR: process.platform === "win32" ? path.join(os.tmpdir(), "cyb-ab-manual-2") : "/tmp/cyb-ab-manual-2",
    })
    expect(env.CYBER_BROWSER_CDP_ENDPOINT).toBeUndefined()
    expect(env.CYBER_BROWSER_OWN_TAB).toBeUndefined()
    expect(env.CYBER_BROWSER_SHARED_ATTESTATION).toBeUndefined()
    expect(env.AGENT_BROWSER_CDP).toBeUndefined()
    expect(env.AGENT_BROWSER_AUTO_CONNECT).toBeUndefined()
    expect(env.AGENT_BROWSER_PROVIDER).toBeUndefined()
    expect(env.AGENT_BROWSER_PASSIVE).toBe("1")
    expect(env.AGENT_BROWSER_ARGS).toBe("--restore-last-session")
    expect(env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS).toBeUndefined()
    expect(env.AGENT_BROWSER_RESTORE).toBeUndefined()
    expect(env.AGENT_BROWSER_RESTORE_SAVE).toBeUndefined()
  })
})
