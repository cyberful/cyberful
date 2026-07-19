// ── Manual Browser Profile Launcher ─────────────────────────────────
// Opens one of Cyberful's five persistent browser identities so a human can
// establish an authorized target session before starting the application.
// → cyberful/src/dependency/browser-profile.ts — resolves stable profile paths.
// → mcps/browser/browser_mcp.mjs — owns the headed Chromium process and profile lock.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────────

import path from "node:path"
import { fileURLToPath } from "node:url"
import { BrowserProfile } from "../src/dependency/browser-profile"

const profileArgument = process.argv[2]
const profile = Number(profileArgument)
if (!BrowserProfile.isBrowserProfileId(profile)) {
  process.stderr.write("Usage: bun cyberful/script/browser-run.ts <profile 1-5>\n")
  process.exit(2)
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const launcher = path.join(repositoryRoot, "mcps", "browser", "bin", "cyber-browser")
const profileDirectory = BrowserProfile.browserProfileDir(profile)

process.stderr.write(`Opening Cyberful browser profile ${profile}: ${profileDirectory}\n`)
process.stderr.write("Sign in to the authorized target, then close the browser before starting Cyberful.\n")

const child = Bun.spawn([launcher], {
  env: BrowserProfile.manualBrowserProfileEnv(profile),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

// ── The Manual Launcher Owns Browser Shutdown ───────────────────────
// Eager browser mode intentionally waits forever while the Chromium window is
// open. Terminal interruption must therefore reach the child, which performs
// bounded context cleanup and releases the persistent profile lock. Closing the
// browser normally exits the child and requires no second cleanup attempt. The
// parent waits for that exit so a completed Make target proves the profile is
// available to the next Cyberful phase gateway.
// ─────────────────────────────────────────────────────────────────────
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => child.kill(signal))
}

process.exitCode = await child.exited
