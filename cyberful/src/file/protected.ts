// ── Protected Host Filesystem Paths ──────────────────────────────
// Identifies platform directories that workspace scans and watchers must avoid
//   to prevent host permission prompts and traversal of private system data.
// ─────────────────────────────────────────────────────────────────

import os from "node:os"
import path from "node:path"

const home = os.homedir()

// ── Protected Paths Prevent Host Permission Side Effects ────────
// macOS TCC prompts can be triggered merely by traversing private user folders.
// The scanner excludes those paths before stat, watch, or recursive discovery.
// Windows user-data folders receive the equivalent conservative treatment.
// Linux has no platform list here; project ignore rules still apply normally.
// ─────────────────────────────────────────────────────────────────
const DARWIN_HOME = [
  "Music",
  "Pictures",
  "Movies",
  "Downloads",
  "Desktop",
  "Documents",
  "Public",
  "Applications",
  "Library",
]

const DARWIN_LIBRARY = [
  "Application Support/AddressBook",
  "Calendars",
  "Mail",
  "Messages",
  "Safari",
  "Cookies",
  "Application Support/com.apple.TCC",
  "PersonalizationPortrait",
  "Metadata/CoreSpotlight",
  "Suggestions",
]

const DARWIN_ROOT = ["/.DocumentRevisions-V100", "/.Spotlight-V100", "/.Trashes", "/.fseventsd"]

const WIN32_HOME = ["AppData", "Downloads", "Desktop", "Documents", "Pictures", "Music", "Videos", "OneDrive"]

export function names(): ReadonlySet<string> {
  if (process.platform === "darwin") return new Set(DARWIN_HOME)
  if (process.platform === "win32") return new Set(WIN32_HOME)
  return new Set()
}

export function paths(): string[] {
  if (process.platform === "darwin")
    return [
      ...DARWIN_HOME.map((n) => path.join(home, n)),
      ...DARWIN_LIBRARY.map((n) => path.join(home, "Library", n)),
      ...DARWIN_ROOT,
    ]
  if (process.platform === "win32") return WIN32_HOME.map((n) => path.join(home, n))
  return []
}

export * as Protected from "./protected"
