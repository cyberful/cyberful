// ── Layered Environment Bootstrap ────────────────────────────────
// Applies release defaults and the launch directory's optional .env before any
// module resolves paths or captures environment-backed runtime policy.
// → cyberful/src/index.ts — imports this bootstrap before the application graph.
// → cyberful/src/flag/flag.ts — reads the resulting canonical environment.
// ─────────────────────────────────────────────────────────────────
import util from "node:util"
import fs from "node:fs"
import path from "node:path"

// The default `.env` contents, replaced by a build-time `define`; undefined in dev/source mode.
declare const CYBERFUL_EMBEDDED_ENV: string | undefined

const parseEnv = util.parseEnv

function parse(text: string, source: string): Record<string, string | undefined> {
  if (!text) return {}
  try {
    return parseEnv(text)
  } catch (cause) {
    throw new Error(`Failed to parse ${source}`, { cause })
  }
}

function readCwdEnv(): Record<string, string | undefined> {
  const file = path.join(process.cwd(), ".env")
  try {
    return parse(fs.readFileSync(file, "utf8"), file)
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return {}
    throw cause
  }
}

function applyLayeredEnv(): number {
  // ── Existing Process Values Always Win ─────────────────────────
  // Release defaults establish the lowest-priority layer and the launch .env
  // may override them for one workspace. Neither source may replace a value
  // already exported by the invoking process. Parsing and reading happen before
  // mutation, so an invalid layer fails startup without leaving a partially
  // applied environment for modules imported later in the graph.
  // ─────────────────────────────────────────────────────────────────
  const layered = {
    ...parse(typeof CYBERFUL_EMBEDDED_ENV === "string" ? CYBERFUL_EMBEDDED_ENV : "", "embedded .env"),
    ...readCwdEnv(),
  }
  let applied = 0
  for (const [key, value] of Object.entries(layered)) {
    if (value !== undefined && process.env[key] === undefined) {
      process.env[key] = value
      applied++
    }
  }
  return applied
}

export const bootstrapEnvApplied = applyLayeredEnv()
