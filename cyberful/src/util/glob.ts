// ── Filesystem Glob Adapter ──────────────────────────────────────
// Normalizes asynchronous scans, synchronous scans, and path matching behind
// the subset of glob policy used by configuration and skill discovery.
// → cyberful/src/skill/index.ts — discovers compatible skill layouts through this adapter.
// ─────────────────────────────────────────────────────────────────

import { glob, globSync, type GlobOptions } from "glob"
import { minimatch } from "minimatch"

export namespace Glob {
  export interface Options {
    cwd?: string
    absolute?: boolean
    include?: "file" | "all"
    dot?: boolean
    symlink?: boolean
  }

  function toGlobOptions(options: Options): GlobOptions {
    return {
      cwd: options.cwd,
      absolute: options.absolute,
      dot: options.dot,
      follow: options.symlink ?? false,
      nodir: options.include !== "all",
    }
  }

  export async function scan(pattern: string, options: Options = {}): Promise<string[]> {
    const matches = await glob(pattern, toGlobOptions(options))
    return matches.filter((match): match is string => typeof match === "string")
  }

  export function scanSync(pattern: string, options: Options = {}): string[] {
    return globSync(pattern, toGlobOptions(options)).filter((match): match is string => typeof match === "string")
  }

  export function match(pattern: string, filepath: string): boolean {
    return minimatch(filepath, pattern, { dot: true })
  }
}
