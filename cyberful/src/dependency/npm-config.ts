// ── npm Installation Policy Adapter ──────────────────────────────
// Loads npm's effective configuration for an isolated package directory and
// reduces its untyped internal API to validated values Cyberful can consume.
// → cyberful/src/dependency/npm.ts — installs packages with this policy.
// ─────────────────────────────────────────────────────────────────

export * as NpmConfig from "./npm-config"

import { fileURLToPath } from "node:url"
import Config from "@npmcli/config"
import { definitions, flatten, nerfDarts, shorthands } from "@npmcli/config/lib/definitions/index.js"
import { Effect } from "effect"

const npmPath = fileURLToPath(new URL("..", import.meta.url))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const load = (dir: string) =>
  Effect.tryPromise({
    try: async () => {
      const config = new Config({
        npmPath,
        cwd: dir,
        env: { ...process.env },
        argv: [process.execPath, process.execPath],
        execPath: process.execPath,
        platform: process.platform,
        definitions,
        flatten,
        nerfDarts,
        shorthands,
        warn: false,
      })
      await config.load()
      const flat: unknown = config.flat
      if (!isRecord(flat)) throw new Error("npm returned a non-object configuration")
      return flat
    },
    catch: (cause) => cause,
  })

export const registry = (dir: string) =>
  load(dir).pipe(
    Effect.map((config) => {
      const registry = typeof config.registry === "string" ? config.registry : "https://registry.npmjs.org"
      return registry.endsWith("/") ? registry.slice(0, -1) : registry
    }),
  )
