// ── Cross-Platform File Operations ───────────────────────────────
// Provides normalized file reads, writes, upward lookup, path resolution, and
// Windows path conversion for repository and language-server consumers.
// → cyberful/src/effect/filesystem.ts — exposes the Effect service counterpart.
// ─────────────────────────────────────────────────────────────────

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync, statSync } from "node:fs"
import { realpathSync } from "node:fs"
import { dirname, join, resolve as pathResolve, win32 } from "node:path"

// Fast sync version for metadata checks
export async function exists(p: string): Promise<boolean> {
  return existsSync(p)
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function stat(p: string): ReturnType<typeof statSync> | undefined {
  return statSync(p, { throwIfNoEntry: false }) ?? undefined
}

export async function readText(p: string): Promise<string> {
  return readFile(p, "utf-8")
}

export async function readJson(p: string): Promise<unknown> {
  return JSON.parse(await readFile(p, "utf-8"))
}

export async function readBytes(p: string): Promise<Buffer> {
  return readFile(p)
}

export async function readArrayBuffer(p: string): Promise<ArrayBuffer> {
  const buf = await readFile(p)
  return Uint8Array.from(buf).buffer
}

function isEnoent(e: unknown): e is { code: "ENOENT" } {
  return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT"
}

export async function write(p: string, content: string | Buffer | Uint8Array, mode?: number): Promise<void> {
  try {
    if (mode) {
      await writeFile(p, content, { mode })
    } else {
      await writeFile(p, content)
    }
  } catch (e) {
    if (isEnoent(e)) {
      await mkdir(dirname(p), { recursive: true })
      if (mode) {
        await writeFile(p, content, { mode })
      } else {
        await writeFile(p, content)
      }
      return
    }
    throw e
  }
}

export async function writeJson(p: string, data: unknown, mode?: number): Promise<void> {
  return write(p, JSON.stringify(data, null, 2), mode)
}

export async function mimeType(p: string): Promise<string> {
  const { lookup } = await import("mime-types")
  return lookup(p) || "application/octet-stream"
}

/**
 * On Windows, normalize a path to its canonical casing using the filesystem.
 * This is needed because Windows paths are case-insensitive but LSP servers
 * may return paths with different casing than what we send them.
 */
export function normalizePath(p: string): string {
  if (process.platform !== "win32") return p
  const resolved = win32.normalize(win32.resolve(windowsPath(p)))
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

// ── Cache Paths Use One Physical Windows Identity ────────────────
// Git may return MSYS, Cygwin, or Git Bash paths that `path.resolve` alone does
// not translate into the host representation. Resolution first normalizes that
// boundary and then follows symlinks, giving every physical directory one cache
// key. A missing future path keeps its normalized form; other failures propagate.
// ─────────────────────────────────────────────────────────────────
export function resolve(p: string): string {
  const resolved = pathResolve(windowsPath(p))
  try {
    return normalizePath(realpathSync(resolved))
  } catch (e) {
    if (isEnoent(e)) return normalizePath(resolved)
    throw e
  }
}

export function windowsPath(p: string): string {
  if (process.platform !== "win32") return p
  return (
    p
      .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      // Git Bash for Windows paths are typically /<drive>/...
      .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      // Cygwin git paths are typically /cygdrive/<drive>/...
      .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      // WSL paths are typically /mnt/<drive>/...
      .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
  )
}

export async function findUp(
  target: string,
  start: string,
  stop?: string,
  options?: { rootFirst?: boolean },
): Promise<string[]>
export async function findUp(
  target: string[],
  start: string,
  stop?: string,
  options?: { rootFirst?: boolean },
): Promise<string[]>
export async function findUp(
  target: string | string[],
  start: string,
  stop?: string,
  options?: { rootFirst?: boolean },
) {
  const dirs = [start]
  let current = start
  while (true) {
    if (stop === current) break
    const parent = dirname(current)
    if (parent === current) break
    dirs.push(parent)
    current = parent
  }

  const targets = Array.isArray(target) ? target : [target]
  const result = []
  for (const dir of options?.rootFirst ? dirs.toReversed() : dirs) {
    for (const item of targets) {
      const search = join(dir, item)
      if (await exists(search)) result.push(search)
    }
  }
  return result
}

export * as Filesystem from "./filesystem"
