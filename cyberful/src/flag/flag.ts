// ── Process Runtime Flags ────────────────────────────────────────
// Normalizes environment-backed feature switches and exposes late-bound values
// for settings that tests and command bootstrap may establish after import.
// → cyberful/src/bootstrap-env.ts — applies environment layers before static flags are read.
// → cyberful/src/effect/runtime-flags.ts — injects project-scoped runtime policy.
// ─────────────────────────────────────────────────────────────────

import { Config } from "effect"

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["CYBERFUL_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]

export const Flag = {
  CYBERFUL_AUTO_HEAP_SNAPSHOT: truthy("CYBERFUL_AUTO_HEAP_SNAPSHOT"),
  CYBERFUL_GIT_BASH_PATH: process.env["CYBERFUL_GIT_BASH_PATH"],
  CYBERFUL_CONFIG: process.env["CYBERFUL_CONFIG"],
  CYBERFUL_CONFIG_CONTENT: process.env["CYBERFUL_CONFIG_CONTENT"],
  CYBERFUL_DISABLE_TERMINAL_TITLE: truthy("CYBERFUL_DISABLE_TERMINAL_TITLE"),
  CYBERFUL_SHOW_TTFD: truthy("CYBERFUL_SHOW_TTFD"),
  CYBERFUL_DISABLE_MOUSE: truthy("CYBERFUL_DISABLE_MOUSE"),
  CYBERFUL_FAKE_VCS: process.env["CYBERFUL_FAKE_VCS"],
  CYBERFUL_SERVER_PASSWORD: process.env["CYBERFUL_SERVER_PASSWORD"],
  CYBERFUL_SERVER_USERNAME: process.env["CYBERFUL_SERVER_USERNAME"],

  // Experimental
  CYBERFUL_EXPERIMENTAL_FILEWATCHER: Config.boolean("CYBERFUL_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  CYBERFUL_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("CYBERFUL_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  CYBERFUL_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("CYBERFUL_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  CYBERFUL_DB: process.env["CYBERFUL_DB"],

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get CYBERFUL_DISABLE_PROJECT_CONFIG() {
    return truthy("CYBERFUL_DISABLE_PROJECT_CONFIG")
  },
  get CYBERFUL_TUI_CONFIG() {
    return process.env["CYBERFUL_TUI_CONFIG"]
  },
  get CYBERFUL_CONFIG_DIR() {
    return process.env["CYBERFUL_CONFIG_DIR"]
  },
}
