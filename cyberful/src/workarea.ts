// ── Canonical Workarea Boundary ──────────────────────────────────
// Validates workarea names, creates their host-owned directories, and keeps
//   persisted workarea selection scoped to one project.
// → cyberful/src/session/prompt.ts — runs workflows inside the returned boundary.
// @docs/user-guide/sessions-and-reports.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { constants } from "node:fs"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises"
import { Global } from "@/global"
import { Flock } from "@/util/flock"
import * as Filesystem from "@/util/filesystem"

const STATE_FILE = path.join(Global.Path.state, "workareas.json")

type WorkareaState = Record<string, string>

function isErrno(error: unknown, code: string): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

export function normalizeWorkarea(input: string | undefined) {
  const workarea = input?.trim()
  if (!workarea) return undefined
  if (workarea.includes("/") || workarea.includes("\\") || workarea.includes("..")) {
    throw new Error("Workarea cannot contain path separators or '..'.")
  }
  return workarea
}

export function requireWorkarea(input: string | undefined) {
  const workarea = normalizeWorkarea(input)
  if (!workarea) throw new Error("Workarea is required.")
  return workarea
}

export function workareaDirectoryName(input: string) {
  const workarea = requireWorkarea(input)
  const slug = workarea
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")

  if (!slug || slug === "." || slug === "..") throw new Error("Workarea does not produce a safe directory name.")
  return slug
}

export function workareaRelativePath(input: string) {
  return `work/${workareaDirectoryName(input)}`
}

export function workareaAbsolutePath(projectPath: string, input: string) {
  return path.join(path.resolve(projectPath), workareaRelativePath(input))
}

// ── Workarea State Uses The Server Project Root ─────────────────
// TUI project contexts expose both a project directory and a VCS worktree, but
// non-Git projects may report a synthetic root worktree. Session submission and
// home-screen restoration must therefore prefer the server project directory,
// or they can write and read the persisted selection under different keys. The
// process fallback applies only when neither project path is available.
// ─────────────────────────────────────────────────────────────────

export function workareaProjectRoot(input: {
  directory: string | undefined
  worktree: string | undefined
  fallback: string
}) {
  return input.directory || input.worktree || input.fallback
}

// ── Every Workarea Segment Must Be A Plain Directory ─────────────
// A lexical `project/work/name` check is insufficient because either directory
// may already be a symlink into an unrelated location. Create only one segment
// at a time, inspect the resulting inode without following links, and then prove
// its canonical path remains under the canonical parent. The returned path is
// the canonical boundary that runtime callers must use for later file access.
// ─────────────────────────────────────────────────────────────────

async function ensurePlainChildDirectory(parent: string, name: string) {
  const child = path.join(parent, name)
  const existing = await lstat(child).catch((error: unknown) => {
    if (isErrno(error, "ENOENT")) return undefined
    throw error
  })
  if (!existing) {
    await mkdir(child, { mode: 0o700 }).catch((error: unknown) => {
      if (!isErrno(error, "EEXIST")) throw error
    })
  }
  const info = await lstat(child)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`Workarea path '${name}' must be a plain directory.`)
  const canonical = await realpath(child)
  const relative = path.relative(parent, canonical)
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error(`Workarea path '${name}' escapes its project boundary.`)
  return canonical
}

function containedWorkareaSegments(relativePath: string, operation: string) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\0"))
    throw new Error(`${operation} requires a non-empty relative path.`)
  const portable = relativePath.replaceAll("\\", "/")
  const segments = portable.split("/")
  if (path.posix.isAbsolute(portable) || segments.some((segment) => !segment || segment === "." || segment === ".."))
    throw new Error(`${operation} path must stay relative to the canonical workarea.`)
  return segments
}

async function canonicalPlainWorkarea(workareaRoot: string) {
  if (!path.isAbsolute(workareaRoot)) throw new Error("Workarea root must be an absolute canonical path.")
  const requested = path.resolve(workareaRoot)
  const info = await lstat(requested)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Workarea root must be a plain directory.")
  const canonical = await realpath(requested)
  if (canonical !== requested) throw new Error("Workarea root must already be canonical.")
  return canonical
}

export async function ensureWorkareaDirectory(workareaRoot: string, relativePath: string) {
  let current = await canonicalPlainWorkarea(workareaRoot)
  for (const segment of containedWorkareaSegments(relativePath, "Workarea directory"))
    current = await ensurePlainChildDirectory(current, segment)
  return current
}

// ── Host File Replacement Never Opens The Destination ────────────
// A regular destination may be replaced, but a symlink or special file is a
// hard failure. New bytes are written through an exclusive no-follow handle to
// an unpredictable sibling, flushed, and atomically renamed over the leaf. A
// concurrent leaf swap is replaced as a directory entry rather than followed.
// This protects the normal host boundary; it does not claim an openat-style
// defense if another process concurrently replaces an already-validated parent.
// ─────────────────────────────────────────────────────────────────

export async function replaceWorkareaFile(
  workareaRoot: string,
  relativePath: string,
  content: string | Uint8Array,
  options: { readonly mode?: number } = {},
) {
  const segments = containedWorkareaSegments(relativePath, "Workarea file")
  const filename = segments.pop()
  if (!filename) throw new Error("Workarea file path must name a regular leaf.")
  const root = await canonicalPlainWorkarea(workareaRoot)
  const directory = segments.length > 0 ? await ensureWorkareaDirectory(root, segments.join("/")) : root
  const destination = path.join(directory, filename)
  const existing = await lstat(destination).catch((error: unknown) => {
    if (isErrno(error, "ENOENT")) return undefined
    throw error
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error("Workarea file destination must be a regular file, not a link or special file.")

  const temporary = path.join(directory, `.cyberful-${randomUUID()}.tmp`)
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
    options.mode ?? 0o600,
  )
  let handleOpen = true
  try {
    await handle.writeFile(content)
    await handle.sync()
    await handle.close().finally(() => {
      handleOpen = false
    })
    await rename(temporary, destination)
  } finally {
    if (handleOpen) await handle.close()
    await rm(temporary, { force: true })
  }
  return destination
}

// ── Append-Only Journals Retain The Same Workarea Boundary ──────
// Provider and diagnostic ledgers are naturally line-oriented. O_APPEND gives
// each queued writer one atomic leaf update without repeatedly replacing a
// growing file; O_NOFOLLOW and the plain-parent checks retain the workarea
// boundary used by replacement writes.
// ─────────────────────────────────────────────────────────────────
export async function appendWorkareaFile(
  workareaRoot: string,
  relativePath: string,
  content: string | Uint8Array,
  options: { readonly mode?: number } = {},
) {
  const segments = containedWorkareaSegments(relativePath, "Workarea file append")
  const filename = segments.pop()
  if (!filename) throw new Error("Workarea file append path must name a regular leaf.")
  const root = await canonicalPlainWorkarea(workareaRoot)
  const directory = segments.length > 0 ? await ensureWorkareaDirectory(root, segments.join("/")) : root
  const destination = path.join(directory, filename)
  const existing = await lstat(destination).catch((error: unknown) => {
    if (isErrno(error, "ENOENT")) return undefined
    throw error
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error("Workarea append destination must be a regular file, not a link or special file.")
  const handle = await open(
    destination,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
    options.mode ?? 0o600,
  )
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return destination
}

export interface WorkareaFileChunk {
  readonly content: string
  readonly offset: number
  readonly end: number
  readonly total: number
  readonly nextOffset?: number
}

// ── Bounded Artifact Reads Preserve The Same Boundary ────────────
// Live tool output artifacts are host-owned files below a canonical workarea.
// Expansion reads must not follow a symlink introduced after persistence, nor
// load a multi-megabyte result merely to render its first page. Validate every
// directory component, open the leaf with O_NOFOLLOW, and return at most one
// UTF-8-aligned block.
// ─────────────────────────────────────────────────────────────────
export async function readWorkareaFileChunk(
  workareaRoot: string,
  relativePath: string,
  options: { readonly offset?: number; readonly limit?: number } = {},
): Promise<WorkareaFileChunk> {
  const segments = containedWorkareaSegments(relativePath, "Workarea file read")
  const filename = segments.pop()
  if (!filename) throw new Error("Workarea file read path must name a regular leaf.")
  let directory = await canonicalPlainWorkarea(workareaRoot)
  for (const segment of segments) {
    const child = path.join(directory, segment)
    const info = await lstat(child)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Workarea file read path contains a non-directory or symlink.")
    const canonical = await realpath(child)
    const relation = path.relative(directory, canonical)
    if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation))
      throw new Error("Workarea file read path escapes its canonical parent.")
    directory = canonical
  }

  const target = path.join(directory, filename)
  const leaf = await lstat(target)
  if (!leaf.isFile() || leaf.isSymbolicLink())
    throw new Error("Workarea file read destination must be a regular file, not a link or special file.")

  const offset = options.offset ?? 0
  const limit = options.limit ?? 64 * 1024
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Workarea file read offset must be non-negative.")
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 * 1024)
    throw new Error("Workarea file read limit must be between 1 and 65536 bytes.")

  const handle = await open(
    target,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
  )
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error("Workarea file read destination changed type during open.")
    const total = stat.size
    if (offset > total) throw new Error("Workarea file read offset exceeds the artifact size.")
    const requested = Math.min(limit, total - offset)
    const buffer = Buffer.alloc(requested)
    const { bytesRead } = requested > 0 ? await handle.read(buffer, 0, requested, offset) : { bytesRead: 0 }
    let visible = buffer.subarray(0, bytesRead)
    if (offset + bytesRead < total) {
      const decoder = new TextDecoder("utf-8", { fatal: true })
      for (let trim = 0; trim <= Math.min(3, visible.length); trim++) {
        const candidate = visible.subarray(0, visible.length - trim)
        try {
          decoder.decode(candidate)
          visible = candidate
          break
        } catch {
          continue
        }
      }
    }
    const end = offset + visible.length
    return {
      content: visible.toString("utf8"),
      offset,
      end,
      total,
      ...(end < total ? { nextOffset: end } : {}),
    }
  } finally {
    await handle.close()
  }
}

export async function ensureWorkarea(projectPath: string, input: string) {
  const project = await realpath(path.resolve(projectPath))
  const work = await ensurePlainChildDirectory(project, "work")
  return ensurePlainChildDirectory(work, workareaDirectoryName(input))
}

export function workareaSystemPrompt(input: string) {
  const rel = workareaRelativePath(input)
  return [
    "<system-reminder>",
    `Active workarea: ${rel}/`,
    "When you need to write any files, including scratch files, plans, reports, or notes, write only inside this workarea.",
    `The native file tools (write, read, edit) run on the host — address workarea files by this path, e.g. ${rel}/notes.txt. The cyberful-os container tools see the same files under /workspace/, e.g. /workspace/${rel}/notes.txt; use that /workspace/ form only in cyberful-os command arguments, never with the native file tools.`,
    "The Pi AgentRun executes from this workarea under the configured sandbox; keep every engagement artifact inside it.",
    "</system-reminder>",
  ].join("\n")
}

export async function getLastWorkarea(projectPath: string) {
  return normalizeWorkarea((await readState())[projectKey(projectPath)])
}

export async function setLastWorkarea(projectPath: string, workarea: string | undefined) {
  const normalized = normalizeWorkarea(workarea)
  if (!normalized) return

  await Flock.withLock(`workareas:${STATE_FILE}`, async () => {
    await Filesystem.writeJson(STATE_FILE, {
      ...(await readState()),
      [projectKey(projectPath)]: normalized,
    })
  })
}

async function readState(): Promise<WorkareaState> {
  const state = await Filesystem.readJson(STATE_FILE).catch((error: unknown) => {
    if (isErrno(error, "ENOENT")) return undefined
    throw error
  })
  if (typeof state !== "object" || state === null || Array.isArray(state)) return {}
  return Object.fromEntries(
    Object.entries(state).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function projectKey(projectPath: string) {
  return path.resolve(projectPath)
}
