// ── Configuration Search Paths ───────────────────────────────────
// Finds project config files from the active directory toward its worktree and
// returns the global plus explicitly configured definition directories.
// → cyberful/src/config/config.ts — loads and merges files in this order.
// ─────────────────────────────────────────────────────────────────

export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { AppFileSystem } from "@/effect/filesystem"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* AppFileSystem.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (_directory: string, _worktree?: string) {
  return unique([Global.Path.config, ...(Flag.CYBERFUL_CONFIG_DIR ? [Flag.CYBERFUL_CONFIG_DIR] : [])])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
