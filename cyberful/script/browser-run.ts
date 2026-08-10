// ── Manual Browser Profile Launcher ─────────────────────────────────
// Opens one of Cyberful's five persistent browser identities so a human can
// establish an authorized target session before starting the application.
// → cyberful/src/dependency/browser-profile-launcher.ts — owns the shared CLI lifecycle.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────────

import { BrowserProfile } from "../src/dependency/browser-profile"
import { BrowserProfileLauncher } from "../src/dependency/browser-profile-launcher"

const profileArgument = process.argv[2]
const profile = Number(profileArgument)
if (!BrowserProfile.isTargetBrowserProfileId(profile)) {
  process.stderr.write("Usage: bun cyberful/script/browser-run.ts <profile 1-5>\n")
  process.exit(2)
}

process.exitCode = await BrowserProfileLauncher.launchBrowserProfile(profile)
