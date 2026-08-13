// ── Canonical Workarea Boundary ──────────────────────────────────
// Validates workarea names, creates their host-owned directories, and keeps
//   persisted workarea selection scoped to one project.
// → cyberful/src/session/prompt.ts — runs workflows inside the returned boundary.
// @docs/user-guide/sessions-and-reports.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { constants } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises"
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

export type WorkareaToolErrorCode =
  | "path_not_found"
  | "invalid_path"
  | "symlink_forbidden"
  | "wrong_media_type"
  | "wrong_artifact_namespace"
  | "file_too_large"
  | "unsupported_image"
  | "limit_exceeded"
  | "io_failure"

export class WorkareaToolError extends Error {
  readonly code: WorkareaToolErrorCode
  readonly requestedPath: string
  readonly recoveryCall?: {
    readonly tool: string
    readonly arguments: Readonly<Record<string, unknown>>
  }

  constructor(input: {
    readonly code: WorkareaToolErrorCode
    readonly requestedPath: string
    readonly message: string
    readonly cause?: unknown
    readonly recoveryCall?: WorkareaToolError["recoveryCall"]
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "WorkareaToolError"
    this.code = input.code
    this.requestedPath = input.requestedPath
    this.recoveryCall = input.recoveryCall
  }

  toolError() {
    return {
      code: this.code,
      path: this.requestedPath,
      message: this.message,
      ...(this.recoveryCall ? { recovery_call: this.recoveryCall } : {}),
    }
  }
}

function discoveryRecoveryCall(relativePath: string): WorkareaToolError["recoveryCall"] {
  const portable = relativePath.replaceAll("\\", "/")
  const parent = path.posix.dirname(portable)
  return {
    tool: "workarea_list",
    arguments: {
      ...(parent === "." ? {} : { prefix: parent }),
      pattern: path.posix.basename(portable),
      max_depth: 4,
      limit: 50,
    },
  }
}

function translateWorkareaReadError(error: unknown, relativePath: string): WorkareaToolError {
  if (error instanceof WorkareaToolError) return error
  if (isErrno(error, "ENOENT"))
    return new WorkareaToolError({
      code: "path_not_found",
      requestedPath: relativePath,
      message: `Workarea file '${relativePath}' does not exist.`,
      cause: error,
      recoveryCall: discoveryRecoveryCall(relativePath),
    })
  const message = error instanceof Error ? error.message : String(error)
  const code: WorkareaToolErrorCode = /relative|escape|non-empty|offset|limit/iu.test(message)
    ? "invalid_path"
    : /symlink|regular file|non-directory|special file/iu.test(message)
      ? "symlink_forbidden"
      : "io_failure"
  return new WorkareaToolError({
    code,
    requestedPath: relativePath,
    message,
    cause: error,
  })
}

async function openRegularWorkareaFile(workareaRoot: string, relativePath: string) {
  try {
    const segments = containedWorkareaSegments(relativePath, "Workarea file read")
    const filename = segments.pop()
    if (!filename) throw new Error("Workarea file read path must name a regular leaf.")
    let directory = await canonicalPlainWorkarea(workareaRoot)
    for (const segment of segments) {
      const child = path.join(directory, segment)
      const info = await lstat(child)
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new WorkareaToolError({
          code: "symlink_forbidden",
          requestedPath: relativePath,
          message: "Workarea file read path contains a non-directory or symlink.",
        })
      const canonical = await realpath(child)
      const relation = path.relative(directory, canonical)
      if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation))
        throw new WorkareaToolError({
          code: "invalid_path",
          requestedPath: relativePath,
          message: "Workarea file read path escapes its canonical parent.",
        })
      directory = canonical
    }

    const target = path.join(directory, filename)
    const leaf = await lstat(target)
    if (!leaf.isFile() || leaf.isSymbolicLink())
      throw new WorkareaToolError({
        code: "symlink_forbidden",
        requestedPath: relativePath,
        message: "Workarea file read destination must be a regular file, not a link or special file.",
      })
    const handle = await open(
      target,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
    )
    const stat = await handle.stat().catch(async (error) => {
      await handle.close()
      throw error
    })
    if (!stat.isFile()) {
      await handle.close()
      throw new WorkareaToolError({
        code: "symlink_forbidden",
        requestedPath: relativePath,
        message: "Workarea file read destination changed type during open.",
      })
    }
    return { handle, size: stat.size }
  } catch (error) {
    throw translateWorkareaReadError(error, relativePath)
  }
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
  const offset = options.offset ?? 0
  const limit = options.limit ?? 64 * 1024
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new WorkareaToolError({
      code: "invalid_path",
      requestedPath: relativePath,
      message: "Workarea file read offset must be non-negative.",
    })
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 * 1024)
    throw new WorkareaToolError({
      code: "limit_exceeded",
      requestedPath: relativePath,
      message: "Workarea file read limit must be between 1 and 65536 bytes.",
    })

  const opened = await openRegularWorkareaFile(workareaRoot, relativePath)
  try {
    const total = opened.size
    if (offset > total)
      throw new WorkareaToolError({
        code: "limit_exceeded",
        requestedPath: relativePath,
        message: "Workarea file read offset exceeds the artifact size.",
      })
    const requested = Math.min(limit, total - offset)
    const buffer = Buffer.alloc(requested)
    const { bytesRead } = requested > 0 ? await opened.handle.read(buffer, 0, requested, offset) : { bytesRead: 0 }
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
    await opened.handle.close()
  }
}

export interface WorkareaImage {
  readonly data: string
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp"
  readonly bytes: number
  readonly width: number
  readonly height: number
}

const WORKAREA_IMAGE_BYTES = 8 * 1024 * 1024
const WORKAREA_IMAGE_EDGE = 8_192
const WORKAREA_IMAGE_PIXELS = 32 * 1024 * 1024

function jpegDimensions(bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++
      continue
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) break
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) break
    if (startOfFrame.has(marker) && length >= 7)
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) }
    offset += length
  }
  return undefined
}

function webpDimensions(bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP")
    return undefined
  const chunk = bytes.toString("ascii", 12, 16)
  if (chunk === "VP8X")
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    }
  if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const dimensions = bytes.readUInt32LE(21)
    return {
      width: (dimensions & 0x3fff) + 1,
      height: ((dimensions >>> 14) & 0x3fff) + 1,
    }
  }
  return undefined
}

function imageMetadata(bytes: Buffer): Pick<WorkareaImage, "mimeType" | "width" | "height"> | undefined {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  )
    return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  const jpeg = jpegDimensions(bytes)
  if (jpeg) return { mimeType: "image/jpeg", ...jpeg }
  const webp = webpDimensions(bytes)
  if (webp) return { mimeType: "image/webp", ...webp }
  return undefined
}

// ── Image Evidence Is Bounded Before Entering Model Context ─────
// Regular workarea screenshots and renderings are not browser-owned artifacts.
// The host reads them through the same no-follow handle as text, validates a
// small fixed set of headers, and rejects compressed dimensions that could
// expand beyond the model-facing safety limit. No decoder, profile database,
// browser process, or heavyweight native dependency is needed for this path.
// ─────────────────────────────────────────────────────────────────
export async function readWorkareaImage(workareaRoot: string, relativePath: string): Promise<WorkareaImage> {
  const opened = await openRegularWorkareaFile(workareaRoot, relativePath)
  try {
    if (opened.size > WORKAREA_IMAGE_BYTES)
      throw new WorkareaToolError({
        code: "file_too_large",
        requestedPath: relativePath,
        message: `Workarea image exceeds the ${WORKAREA_IMAGE_BYTES}-byte safety bound.`,
      })
    const bytes = await opened.handle.readFile()
    if (bytes.length !== opened.size)
      throw new WorkareaToolError({
        code: "io_failure",
        requestedPath: relativePath,
        message: "Workarea image changed while it was being read.",
      })
    const metadata = imageMetadata(bytes)
    if (!metadata)
      throw new WorkareaToolError({
        code: "unsupported_image",
        requestedPath: relativePath,
        message: "Workarea image must be a structurally valid PNG, JPEG, or WebP file.",
      })
    if (
      metadata.width < 1 ||
      metadata.height < 1 ||
      metadata.width > WORKAREA_IMAGE_EDGE ||
      metadata.height > WORKAREA_IMAGE_EDGE ||
      metadata.width * metadata.height > WORKAREA_IMAGE_PIXELS
    )
      throw new WorkareaToolError({
        code: "limit_exceeded",
        requestedPath: relativePath,
        message: `Workarea image dimensions ${metadata.width}x${metadata.height} exceed the model-facing safety bound.`,
      })
    return {
      data: bytes.toString("base64"),
      bytes: bytes.length,
      ...metadata,
    }
  } finally {
    await opened.handle.close()
  }
}

export interface WorkareaFileEntry {
  readonly path: string
  readonly size: number
}

export interface WorkareaFileListing {
  readonly files: readonly WorkareaFileEntry[]
  readonly truncated: boolean
}

function wildcardPattern(pattern: string): RegExp {
  if (!pattern || pattern.length > 256 || pattern.includes("\0"))
    throw new Error("Workarea list pattern must contain between 1 and 256 characters.")
  const source = [...pattern]
    .map((character) => {
      if (character === "*") return ".*"
      if (character === "?") return "."
      return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
    })
    .join("")
  return new RegExp(`^${source}$`, "u")
}

async function existingWorkareaDirectory(workareaRoot: string, relativeDirectory: string): Promise<string> {
  let directory = await canonicalPlainWorkarea(workareaRoot)
  if (!relativeDirectory || relativeDirectory === ".") return directory
  for (const segment of containedWorkareaSegments(relativeDirectory, "Workarea directory discovery")) {
    const child = path.join(directory, segment)
    const info = await lstat(child)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Workarea directory discovery encountered a non-directory or symlink.")
    const canonical = await realpath(child)
    const relation = path.relative(directory, canonical)
    if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation))
      throw new Error("Workarea directory discovery escaped its canonical parent.")
    directory = canonical
  }
  return directory
}

// ── Bounded Workarea Discovery Never Follows Links ──────────────
// Artifact producers choose their own nested paths, so consumers need bounded
// discovery instead of guessing filenames. Each traversed entry is inspected
// without following links; symlinks and special files are omitted entirely.
// Prefix, depth, wildcard, and result limits keep provider output predictable.
// ─────────────────────────────────────────────────────────────────
export async function listWorkareaFiles(
  workareaRoot: string,
  options: {
    readonly prefix?: string
    readonly pattern?: string
    readonly maxDepth?: number
    readonly maxResults?: number
  } = {},
): Promise<WorkareaFileListing> {
  const prefix = options.prefix?.trim() || "."
  const start = await existingWorkareaDirectory(workareaRoot, prefix)
  const matcher = wildcardPattern(options.pattern?.trim() || "*")
  const maxDepth = options.maxDepth ?? 4
  const maxResults = options.maxResults ?? 256
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 12)
    throw new Error("Workarea list maxDepth must be between 0 and 12.")
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 1_024)
    throw new Error("Workarea list maxResults must be between 1 and 1024.")

  const files: WorkareaFileEntry[] = []
  let truncated = false
  async function visit(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (files.length >= maxResults) {
        truncated = true
        return
      }
      if (manifestTemporary(entry.name)) continue
      const absolute = path.join(directory, entry.name)
      const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (!info) continue
      if (info.isSymbolicLink()) continue
      const relative = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name
      if (info.isFile()) {
        if (matcher.test(relative) || matcher.test(entry.name)) files.push({ path: relative, size: info.size })
        continue
      }
      if (info.isDirectory() && depth < maxDepth) await visit(absolute, relative, depth + 1)
      if (truncated) return
    }
  }
  await visit(start, prefix === "." ? "" : prefix.replaceAll("\\", "/"), 0)
  return { files, truncated }
}

const EVIDENCE_MANIFEST = "EVIDENCE.sha256"
const MANIFEST_DIAGNOSTIC_LIMIT = 50

function comparePortablePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function manifestTemporary(pathname: string): boolean {
  const name = path.posix.basename(pathname)
  return name.startsWith(".cyberful-") || name.endsWith(".tmp") || name.endsWith(".partial")
}

async function hashRegularWorkareaFile(workareaRoot: string, relativePath: string): Promise<string> {
  const chunk = await readWorkareaFileChunk(workareaRoot, relativePath, { limit: 1 })
  const target = path.join(workareaRoot, ...relativePath.split("/"))
  const handle = await open(
    target,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
  )
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== chunk.total)
      throw new Error(`Evidence file '${relativePath}' changed while it was being verified.`)
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(64 * 1024)
    let offset = 0
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset)
      if (bytesRead <= 0) throw new Error(`Evidence file '${relativePath}' ended before its declared size.`)
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    return hash.digest("hex")
  } finally {
    await handle.close()
  }
}

async function evidenceFiles(workareaRoot: string, directory: string): Promise<readonly WorkareaFileEntry[]> {
  const listing = await listWorkareaFiles(workareaRoot, {
    prefix: directory,
    pattern: "*",
    maxDepth: 12,
    maxResults: 1_024,
  })
  if (listing.truncated) throw new Error("Evidence manifest exceeds the 1024-file safety bound.")
  const prefix = !directory || directory === "." ? "" : `${directory.replaceAll("\\", "/")}/`
  return listing.files
    .map((entry) => ({ ...entry, path: prefix && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path }))
    .filter((entry) => entry.path !== EVIDENCE_MANIFEST && !manifestTemporary(entry.path))
    .toSorted((left, right) => comparePortablePath(left.path, right.path))
}

// ── Evidence Manifests Describe Their Own Directory ─────────────
// Creation and verification use the same sorted regular-file inventory. The
// manifest and temporary publication files are excluded, and replacement is
// atomic so repeated creation cannot hash a prior manifest into itself.
// Verification also rejects unlisted additions instead of checking digests only.
// ─────────────────────────────────────────────────────────────────
export async function createEvidenceManifest(workareaRoot: string, directory = ".") {
  const files = await evidenceFiles(workareaRoot, directory)
  const lines: string[] = []
  for (const file of files) {
    if (file.path.includes("\n") || file.path.includes("\r"))
      throw new Error("Evidence manifest paths may not contain newlines.")
    const rooted = directory === "." ? file.path : path.posix.join(directory.replaceAll("\\", "/"), file.path)
    lines.push(`${await hashRegularWorkareaFile(workareaRoot, rooted)}  ${file.path}`)
  }
  const relativeManifest = directory === "." ? EVIDENCE_MANIFEST : path.posix.join(directory, EVIDENCE_MANIFEST)
  const content = lines.length > 0 ? `${lines.join("\n")}\n` : ""
  await replaceWorkareaFile(workareaRoot, relativeManifest, content, { mode: 0o600 })
  return {
    path: relativeManifest,
    files: files.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  }
}

export async function verifyEvidenceManifest(workareaRoot: string, directory = ".") {
  const relativeManifest = directory === "." ? EVIDENCE_MANIFEST : path.posix.join(directory, EVIDENCE_MANIFEST)
  const manifest = await readWorkareaFileChunk(workareaRoot, relativeManifest, { limit: 65_536 })
  if (manifest.nextOffset !== undefined) throw new Error("Evidence manifest exceeds the 65536-byte verification bound.")
  const expected = new Map<string, string>()
  for (const line of manifest.content.split("\n").filter(Boolean)) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
    if (!match || expected.has(match[2]!)) throw new Error("Evidence manifest contains an invalid or duplicate entry.")
    if (match[2]!.includes("\\")) throw new Error("Evidence manifest paths must use portable separators.")
    containedWorkareaSegments(match[2]!, "Evidence manifest entry")
    expected.set(match[2]!, match[1]!)
  }
  const files = await evidenceFiles(workareaRoot, directory)
  const actualPaths = files.map((file) => file.path)
  const actual = new Set(actualPaths)
  const expectedPaths = new Set(expected.keys())
  const missing = [...expectedPaths]
    .filter((pathname) => !actual.has(pathname))
    .toSorted(comparePortablePath)
    .slice(0, MANIFEST_DIAGNOSTIC_LIMIT)
  const unexpected = [...actual]
    .filter((pathname) => !expectedPaths.has(pathname))
    .toSorted(comparePortablePath)
    .slice(0, MANIFEST_DIAGNOSTIC_LIMIT)
  if (missing.length > 0 || unexpected.length > 0)
    return {
      path: relativeManifest,
      valid: false,
      reason: "file_set_mismatch",
      files: files.length,
      missing,
      unexpected,
    }
  const digestMismatches: string[] = []
  for (const file of files) {
    const rooted = directory === "." ? file.path : path.posix.join(directory.replaceAll("\\", "/"), file.path)
    if ((await hashRegularWorkareaFile(workareaRoot, rooted)) !== expected.get(file.path))
      digestMismatches.push(file.path)
  }
  if (digestMismatches.length > 0)
    return {
      path: relativeManifest,
      valid: false,
      reason: "digest_mismatch",
      file: digestMismatches[0],
      digest_mismatches: digestMismatches.slice(0, MANIFEST_DIAGNOSTIC_LIMIT),
      files: files.length,
    }
  return { path: relativeManifest, valid: true, files: files.length }
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
