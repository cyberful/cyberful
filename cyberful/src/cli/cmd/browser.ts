// ── Browser Profile CLI Command ──────────────────────────────────────
// Exposes the five persistent browser identities through browser-1…browser-5
// and renders launch failures without revealing browser-profile contents.
// → cyberful/src/dependency/browser-profile-launcher.ts — owns the browser child.
// @docs/user-guide/interface.md
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────────

import type { CommandModule } from "yargs"
import { BrowserProfile, type TargetBrowserProfileId } from "@/dependency/browser-profile"
import { BrowserProfileLauncher } from "@/dependency/browser-profile-launcher"
import { UI } from "../ui"
import { errorMessage } from "@/util/error"

export const BROWSER_PROFILE_COMMANDS = BrowserProfile.TARGET_BROWSER_PROFILE_IDS.map((profile) => `browser-${profile}`)

export function browserProfileCommandKind(value: string): "supported" | "unsupported" | "unrelated" {
  if (!value.startsWith("browser-")) return "unrelated"
  return BROWSER_PROFILE_COMMANDS.includes(value) ? "supported" : "unsupported"
}

export function browserProfileFromCommand(value: unknown): TargetBrowserProfileId {
  if (typeof value !== "string") throw new Error("Browser profile command is missing")
  const match = /^browser-(\d+)$/.exec(value)
  const profile = match ? Number(match[1]) : Number.NaN
  if (!BrowserProfile.isTargetBrowserProfileId(profile)) throw new RangeError(invalidBrowserProfileMessage(value))
  return profile
}

export function invalidBrowserProfileMessage(command: string): string {
  const requested = command.startsWith("browser-") ? command.slice("browser-".length) : command
  return `Invalid browser profile '${requested}'. Use cyberful browser-1 through cyberful browser-5.`
}

export const BrowserCommand = {
  command: BROWSER_PROFILE_COMMANDS,
  describe: "open a persistent browser profile for target pre-authentication",
  builder: (yargs) => yargs,
  handler: async (args) => {
    const profile = browserProfileFromCommand(args._[0])
    try {
      const exitCode = await BrowserProfileLauncher.launchBrowserProfile(profile)
      process.exitCode = exitCode
      if (exitCode !== 0) UI.error(`Cyberful browser profile ${profile} exited with status ${exitCode}.`)
    } catch (error) {
      UI.error(`Could not open Cyberful browser profile ${profile}: ${errorMessage(error)}`)
      process.exitCode = 1
    }
  },
} satisfies CommandModule<object, object>
