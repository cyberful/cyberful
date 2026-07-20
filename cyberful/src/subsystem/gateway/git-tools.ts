// ── Code Audit Diff Boundary ────────────────────────────────────
// Seals an offline Git diff and its working-tree overlay for a deep Code Audit.
// Repository configuration, filters, hooks, credentials, and network transports
// are disabled; the user's checkout is never modified.
// → cyberful/src/subsystem/gateway/server.ts — exposes the phase-scoped tool.
// ────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import path from "node:path"
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises"
import { replaceWorkareaFile } from "@/workarea"
import { effectiveSourceRoot } from "./source-tools"

const MAX_GIT_OUTPUT = 2 * 1024 * 1024
const MAX_AUDIT_PATCH_BYTES = MAX_GIT_OUTPUT
const MAX_UNTRACKED_FILES = 20_000
const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60_000
const MAX_ATTRIBUTE_FILES = 2_000
const MAX_ATTRIBUTE_BYTES = 1024 * 1024
const FILTER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const OFFLINE_GIT_ENV_ALLOWLIST = new Set([
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LANGUAGE",
  "LOGNAME",
  "OS",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR",
])
const COMMON_GIT_ARGS = [
  "--no-optional-locks",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.quotepath=false",
  "-c",
  `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
] as const
const OFFLINE_GIT_ARGS = [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "protocol.git.allow=never",
  "-c",
  "protocol.http.allow=never",
  "-c",
  "protocol.https.allow=never",
  "-c",
  "protocol.ssh.allow=never",
  "-c",
  "credential.helper=",
  "-c",
  "credential.interactive=false",
  "-c",
  "core.askPass=",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "filter.lfs.clean=",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.required=false",
  "-c",
  "fetch.recurseSubmodules=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
] as const

export const GIT_TOOL_DEFS = [
  {
    name: "audit_diff_prepare",
    description:
      "Seal an offline Git diff for Code Audit. Defaults to the merge base of HEAD and the local default branch, including staged, unstaged, and untracked files; never fetches or modifies the checkout.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        base_ref: { type: "string", maxLength: 200 },
        head_ref: { type: "string", maxLength: 200 },
        include_untracked: { type: "boolean", default: true },
      },
    },
  },
] as const

export type GitToolName = (typeof GIT_TOOL_DEFS)[number]["name"]

interface GitContext {
  readonly sourceRoot: string
  readonly workareaRoot: string
  readonly sessionLogRoot?: string
  readonly sessionID: string
}

interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly timedOut: boolean
}

function contextFor(sessionID: string): GitContext | undefined {
  const sourceRoot = process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT?.trim()
  const workareaRoot = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim()
  const sessionLogRoot = process.env.CYBERFUL_SUBSYSTEM_SESSION_LOG_ROOT?.trim()
  if (!sourceRoot || !workareaRoot || !path.isAbsolute(sourceRoot) || !path.isAbsolute(workareaRoot)) return
  if (sessionLogRoot && !path.isAbsolute(sessionLogRoot)) return
  return {
    sourceRoot: path.resolve(sourceRoot),
    workareaRoot: path.resolve(workareaRoot),
    ...(sessionLogRoot ? { sessionLogRoot: path.resolve(sessionLogRoot) } : {}),
    sessionID,
  }
}

function isContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function readBounded(stream: ReadableStream<Uint8Array> | null, limit: number) {
  if (!stream) return { text: "", truncated: false }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let retained = 0
  let truncated = false
  while (true) {
    const next = await reader.read()
    if (next.done) break
    if (retained >= limit) {
      truncated = true
      continue
    }
    const remaining = limit - retained
    const chunk = next.value.byteLength <= remaining ? next.value : next.value.slice(0, remaining)
    chunks.push(chunk)
    retained += chunk.byteLength
    truncated ||= chunk.byteLength !== next.value.byteLength
  }
  const bytes = new Uint8Array(retained)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(bytes), truncated }
}

async function command(argv: readonly string[], cwd: string, limit = MAX_GIT_OUTPUT) {
  const child = Bun.spawn([...argv], {
    cwd,
    env: offlineGitEnvironment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, DEFAULT_COMMAND_TIMEOUT_MS)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, limit),
      readBounded(child.stderr, limit),
      child.exited,
    ])
    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      timedOut,
    } satisfies CommandResult
  } finally {
    clearTimeout(timer)
  }
}

// Repository configuration is untrusted. Offline Git receives a small OS
// allowlist and explicit no-network, no-credential, no-hook controls.
export function offlineGitEnvironment(
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(inherited).filter((entry): entry is [string, string] => {
      const name = entry[0].toUpperCase()
      return entry[1] !== undefined && (OFFLINE_GIT_ENV_ALLOWLIST.has(name) || /^LC_[A-Z0-9_]+$/.test(name))
    }),
  )
  return {
    ...environment,
    GIT_ALLOW_PROTOCOL: "",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  }
}

function collectFilterNames(text: string, names: Set<string>) {
  for (const match of text.matchAll(/(?:^|\s)filter=([^\s#]+)/gm)) {
    const name = match[1]
    if (!name || !FILTER_NAME.test(name)) throw new Error("repository declares an unsafe Git filter name")
    names.add(name)
  }
  for (const match of text.matchAll(/^\s*\[filter\s+"([^"]+)"\]\s*$/gim)) {
    const name = match[1]
    if (!name || !FILTER_NAME.test(name)) throw new Error("repository config declares an unsafe Git filter name")
    names.add(name)
  }
}

async function readFilterDeclaration(file: string, names: Set<string>) {
  const metadata = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined
    throw error
  })
  if (!metadata) return
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_ATTRIBUTE_BYTES)
    throw new Error("repository Git filter declaration is not a bounded regular file")
  collectFilterNames(await readFile(file, "utf8"), names)
}

async function gitMetadataDirectories(sourceRoot: string) {
  const dotGit = path.join(sourceRoot, ".git")
  const metadata = await lstat(dotGit).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!metadata) return []
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) return [dotGit]
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4_096)
    throw new Error("repository Git metadata pointer is unsafe")
  const pointer = (await readFile(dotGit, "utf8")).trim().match(/^gitdir:\s*(.+)$/i)?.[1]
  if (!pointer) throw new Error("repository Git metadata pointer is invalid")
  const administration = path.resolve(sourceRoot, pointer)
  const administrationMetadata = await lstat(administration)
  if (!administrationMetadata.isDirectory() || administrationMetadata.isSymbolicLink())
    throw new Error("repository Git administration directory is unsafe")
  const commonPointer = path.join(administration, "commondir")
  const commonMetadata = await lstat(commonPointer).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!commonMetadata) return [administration]
  if (!commonMetadata.isFile() || commonMetadata.isSymbolicLink() || commonMetadata.size > 4_096)
    throw new Error("repository Git common-directory pointer is unsafe")
  const common = path.resolve(administration, (await readFile(commonPointer, "utf8")).trim())
  const resolvedMetadata = await lstat(common)
  if (!resolvedMetadata.isDirectory() || resolvedMetadata.isSymbolicLink())
    throw new Error("repository Git common directory is unsafe")
  return [...new Set([administration, common])]
}

async function offlineGitFilterArgs(context: GitContext) {
  const names = new Set(["lfs"])
  const directories = [context.sourceRoot]
  let attributeFiles = 0
  while (directories.length > 0) {
    const directory = directories.pop()
    if (!directory) break
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isSymbolicLink() || entry.name === ".git") continue
      if (entry.isDirectory()) {
        if (isContained(context.workareaRoot, candidate) && !isContained(context.workareaRoot, context.sourceRoot))
          continue
        directories.push(candidate)
        continue
      }
      if (!entry.isFile() || entry.name !== ".gitattributes") continue
      attributeFiles++
      if (attributeFiles > MAX_ATTRIBUTE_FILES) throw new Error("repository has too many Git attribute files")
      await readFilterDeclaration(candidate, names)
    }
  }
  const metadataDirectories = await gitMetadataDirectories(context.sourceRoot)
  await Promise.all(
    metadataDirectories.flatMap((directory) => [
      readFilterDeclaration(path.join(directory, "config"), names),
      readFilterDeclaration(path.join(directory, "config.worktree"), names),
      readFilterDeclaration(path.join(directory, "info", "attributes"), names),
    ]),
  )
  return [...names]
    .sort()
    .flatMap((name) => [
      "-c",
      `filter.${name}.clean=`,
      "-c",
      `filter.${name}.smudge=`,
      "-c",
      `filter.${name}.process=`,
      "-c",
      `filter.${name}.required=false`,
    ])
}

async function git(context: GitContext, args: readonly string[], limit = MAX_GIT_OUTPUT) {
  const filterArgs = await offlineGitFilterArgs(context)
  return command(["git", ...COMMON_GIT_ARGS, ...OFFLINE_GIT_ARGS, ...filterArgs, ...args], context.sourceRoot, limit)
}

function requireSuccess(result: CommandResult, operation: string) {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(
      `${operation} ${result.timedOut ? "timed out" : `failed with exit ${result.exitCode}`}${detail ? `: ${detail}` : ""}`,
    )
  }
  return result.stdout.trim()
}

function requireComplete(result: CommandResult, operation: string) {
  const output = requireSuccess(result, operation)
  if (result.truncated) throw new Error(`${operation} exceeded its host output limit`)
  return output
}

async function repositoryRoot(context: GitContext) {
  const root = requireSuccess(await git(context, ["rev-parse", "--show-toplevel"]), "Git repository discovery")
  const resolved = await realpath(root)
  const source = await realpath(context.sourceRoot)
  if (!isContained(resolved, source)) throw new Error("source root is outside the discovered Git repository")
  requireSuccess(await git(context, ["rev-parse", "--verify", "HEAD^{commit}"]), "HEAD verification")
}

async function localCommit(context: GitContext, ref: string) {
  if (!ref || ref.startsWith("-")) throw new Error("Git ref must be a non-option local ref")
  return requireSuccess(await git(context, ["rev-parse", "--verify", `${ref}^{commit}`]), `Local ref '${ref}' verification`)
}

async function defaultBranch(context: GitContext) {
  const remoteHead = await git(context, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
  if (remoteHead.exitCode === 0) return remoteHead.stdout.trim().replace(/^refs\/remotes\//, "")
  for (const candidate of ["main", "master"]) {
    if ((await git(context, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`])).exitCode === 0)
      return candidate
  }
  throw new Error("no local default branch could be determined; pass base_ref explicitly")
}

function ownedRoots(context: GitContext) {
  return [context.workareaRoot, context.sessionLogRoot]
    .filter((root): root is string => Boolean(root))
    .flatMap((root) => {
      const relative = path.relative(context.sourceRoot, root)
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return []
      return [relative.split(path.sep).join("/")]
    })
    .filter((relative, index, roots) => roots.indexOf(relative) === index)
    .sort()
}

function excludedPathspecs(roots: readonly string[]) {
  return roots.flatMap((root) => [`:(top,exclude)${root}`, `:(top,exclude)${root}/**`])
}

async function rejectTrackedOwnedRoots(context: GitContext, roots: readonly string[]) {
  if (roots.length === 0) return
  const tracked = requireComplete(await git(context, ["ls-files", "-z", "--", ...roots]), "Owned path collision check")
    .split("\0")
    .filter(Boolean)
  if (tracked.length > 0) throw new Error(`runtime paths collide with tracked project files: ${tracked.slice(0, 10).join(", ")}`)
}

async function untrackedFiles(context: GitContext, exclusions: readonly string[]) {
  const files = requireComplete(
    await git(context, ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...exclusions]),
    "Untracked file inventory",
  )
    .split("\0")
    .filter(Boolean)
    .sort()
  if (files.length > MAX_UNTRACKED_FILES) throw new Error("untracked file inventory exceeds its host limit")
  return files
}

function porcelainStatus(output: string) {
  const tokens = output.split("\0")
  if (tokens.at(-1) === "") tokens.pop()
  const entries: Array<{ code: string; path: string; original_path?: string }> = []
  for (let index = 0; index < tokens.length; index++) {
    const record = tokens[index]
    if (!record || record.length < 4 || record[2] !== " ") throw new Error("Git returned malformed status")
    const code = record.slice(0, 2)
    const file = record.slice(3)
    if (!file) throw new Error("Git returned an unsafe path")
    if (code.includes("R") || code.includes("C")) {
      const original = tokens[++index]
      if (!original) throw new Error("Git returned a malformed rename status")
      entries.push({ code, path: file, original_path: original })
    } else entries.push({ code, path: file })
  }
  return entries
}

async function ensurePlainDirectory(root: string, relative: string) {
  let current = root
  for (const segment of relative.split("/").filter(Boolean)) {
    current = path.join(current, segment)
    const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!existing) await mkdir(current, { mode: 0o700 })
    const created = await lstat(current)
    if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("audit output path is unsafe")
    if (!isContained(root, await realpath(current))) throw new Error("audit output path escapes the workarea")
  }
}

async function prepareDiff(context: GitContext, args: Record<string, unknown>) {
  await repositoryRoot(context)
  const roots = ownedRoots(context)
  const exclusions = excludedPathspecs(roots)
  await rejectTrackedOwnedRoots(context, roots)
  const explicitBase = typeof args.base_ref === "string" ? args.base_ref.trim() : undefined
  const explicitHead = typeof args.head_ref === "string" ? args.head_ref.trim() : undefined
  const head = await localCommit(context, explicitHead || "HEAD")
  const branchBase = await localCommit(context, explicitBase || (await defaultBranch(context)))
  const base = requireSuccess(await git(context, ["merge-base", branchBase, head]), "Merge-base resolution")
  const branch = (await git(context, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim() || undefined
  const diffTail = ["--", ".", ...exclusions]
  const patchArgs = explicitHead
    ? ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", base, head, ...diffTail]
    : ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", base, ...diffTail]
  const patchResult = await git(context, patchArgs, MAX_AUDIT_PATCH_BYTES)
  requireComplete(patchResult, "Audit patch generation")
  const statusResult = await git(context, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...diffTail])
  requireComplete(statusResult, "Audit status")
  const untracked = args.include_untracked === false || explicitHead ? [] : await untrackedFiles(context, exclusions)
  const changedArgs = explicitHead
    ? ["diff", "--name-only", "-z", "--no-renames", base, head, ...diffTail]
    : ["diff", "--name-only", "-z", "--no-renames", base, ...diffTail]
  const changed = requireComplete(await git(context, changedArgs), "Changed-file inventory").split("\0").filter(Boolean)
  const reviewableFiles = [...new Set([...changed, ...untracked])].sort()
  let patchText = patchResult.stdout
  let patchBytes = Buffer.byteLength(patchText)
  for (const file of untracked) {
    const separator = patchText ? "\n" : ""
    const remaining = MAX_AUDIT_PATCH_BYTES - patchBytes - Buffer.byteLength(separator)
    if (remaining < 0) throw new Error("audit patch exceeds its aggregate host byte limit")
    const addition = await git(
      context,
      ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--binary", "--", "/dev/null", file],
      remaining + 1,
    )
    if (addition.exitCode !== 0 && addition.exitCode !== 1)
      throw new Error(`untracked patch failed for '${file}': ${addition.stderr.trim()}`)
    if (addition.truncated || Buffer.byteLength(addition.stdout) > remaining)
      throw new Error("audit patch exceeds its aggregate host byte limit")
    patchText += separator + addition.stdout
    patchBytes += Buffer.byteLength(separator + addition.stdout)
  }
  const outputRoot = "raw/code-audit/diff"
  await ensurePlainDirectory(context.workareaRoot, outputRoot)
  await replaceWorkareaFile(context.workareaRoot, `${outputRoot}/changes.patch`, patchText)
  const manifest = {
    version: 1,
    status: reviewableFiles.length > 0 ? "ready" : "empty",
    base,
    head,
    branch,
    includes_working_tree: !explicitHead,
    untracked,
    changed_files: reviewableFiles,
    excluded_runtime_roots: roots,
    working_tree: porcelainStatus(statusResult.stdout),
    patch_sha256: createHash("sha256").update(patchText).digest("hex"),
    patch_bytes: patchBytes,
    patch_truncated: false,
    created_at: new Date().toISOString(),
  }
  await replaceWorkareaFile(context.workareaRoot, `${outputRoot}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n")
  return {
    ...manifest,
    patch_path: `${outputRoot}/changes.patch`,
    manifest_path: `${outputRoot}/manifest.json`,
  }
}

async function canonicalContext(sessionID: string) {
  const context = contextFor(sessionID)
  if (!context) throw new Error("audit diff requires absolute source and workarea roots")
  const workareaRoot = await realpath(context.workareaRoot)
  const configuredSourceRoot = await realpath(context.sourceRoot)
  return {
    ...context,
    sourceRoot: await effectiveSourceRoot(configuredSourceRoot, workareaRoot),
    workareaRoot,
  }
}

export function gitToolsAvailable() {
  return contextFor("availability") !== undefined
}

export function isGitTool(name: string): name is GitToolName {
  return name === "audit_diff_prepare"
}

export async function handleGitTool(sessionID: string, name: GitToolName, args: Record<string, unknown>) {
  const context = await canonicalContext(sessionID)
  switch (name) {
    case "audit_diff_prepare":
      return prepareDiff(context, args)
  }
}
