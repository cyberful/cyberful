// ── Secure Review And Remediation Git Boundary ───────────────────
// Prepares local-only review diffs and isolated remediation worktrees, records
// containerized verification, and publishes only after fixed TUI consent.
// → cyberful/src/subsystem/gateway/server.ts — owns the interactive consent bridge.
// ─────────────────────────────────────────────────────────────────

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import path from "node:path"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, readdir, readlink, realpath } from "node:fs/promises"
import { replaceWorkareaFile } from "@/workarea"
import { effectiveSourceRoot } from "./source-tools"

const MAX_GIT_OUTPUT = 2 * 1024 * 1024
const MAX_REVIEW_PATCH_BYTES = MAX_GIT_OUTPUT
const MAX_REVIEW_UNTRACKED_FILES = 20_000
const MAX_REMEDIATION_PATCH_BYTES = 16 * 1024 * 1024
const MAX_REMEDIATION_TEST_RECORDS = 2_000
const MAX_TEST_OUTPUT = 512 * 1024
const MAX_REMEDIATION_JSON_BYTES = 16 * MAX_TEST_OUTPUT
const MAX_REMEDIATION_MANIFEST_BYTES = 256 * 1024
const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60_000
const MAX_TEST_TIMEOUT_MS = 10 * 60_000
const MAX_FINGERPRINT_FILE_BYTES = 128 * 1024 * 1024
const MAX_FINGERPRINT_TOTAL_BYTES = 512 * 1024 * 1024
const MAX_FINGERPRINT_FILES = 20_000
const OFFLINE_GIT_ENV_ALLOWLIST = new Set([
  "COMSPEC",
  "EMAIL",
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
  "XDG_CONFIG_HOME",
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
  "-c",
  "commit.gpgsign=false",
] as const

export const GIT_TOOL_DEFS = [
  {
    name: "review_prepare",
    description:
      "Prepare a Git-local incremental security-review manifest and patch. Defaults to the merge-base of HEAD and the local default branch, plus staged, unstaged, and untracked files; never fetches.",
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
  {
    name: "remediation_prepare",
    description:
      "Create or return the isolated remediation checkout and cyberful/remediate branch based on HEAD. Dirty files in the user's checkout are recorded but never copied or modified.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: { slug: { type: "string", maxLength: 80 } },
    },
  },
  {
    name: "remediation_test",
    description:
      "Run a model-selected argv-only oracle inside the isolated remediation checkout. The caller declares the exit codes that prove each pre-fix, post-fix, or regression expectation. Post-fix may use a different harness when it retains the same named case and finding set. The host signs each command, result, case binding, and exact Git delta without prescribing test semantics.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        command: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: { type: "string", maxLength: 4_096 },
        },
        stage: { type: "string", enum: ["pre-fix", "post-fix", "regression"] },
        test_case: { type: "string", minLength: 1, maxLength: 200 },
        finding_ids: { type: "array", minItems: 1, maxItems: 200, items: { type: "string", maxLength: 200 } },
        expected_exit_codes: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: { type: "integer", minimum: 0, maximum: 255 },
        },
        timeout_ms: { type: "integer", minimum: 1_000, maximum: MAX_TEST_TIMEOUT_MS },
      },
      required: ["command", "stage", "test_case", "finding_ids", "expected_exit_codes"],
    },
  },
  {
    name: "remediation_publish",
    description:
      "Seal verified remediation changes into a local commit, then ask the human for fixed TUI consent before any push. With consent, pushes and opens a draft GitHub PR or GitLab MR when an adapter is available.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        body: { type: "string", maxLength: 20_000 },
        commit_message: { type: "string", minLength: 1, maxLength: 200 },
        remote: { type: "string", maxLength: 100 },
        finding_ids: { type: "array", maxItems: 200, items: { type: "string", maxLength: 200 } },
      },
      required: ["title", "commit_message", "finding_ids"],
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

function nodeErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

function remediationProofKey() {
  const key = process.env.CYBERFUL_REMEDIATION_PROOF_KEY?.trim()
  if (!key || key.length < 32) throw new Error("remediation proof attestation is unavailable")
  return key
}

export interface PublishProof {
  readonly stage: "pre-fix" | "post-fix" | "regression"
  readonly testCase: string
  readonly command: readonly string[]
  readonly commandSha256: string
  readonly commandIdentitySha256: string
  readonly caseSha256: string
  readonly expectedExitCodes: readonly number[]
  readonly exitCode: number
  readonly outputSha256: string
  readonly treeFingerprint: string
  readonly findingIDs: readonly string[]
  readonly createdAt: string
}

export interface PublishCandidate {
  readonly branch: string
  readonly commit: string
  readonly remote: string
  readonly remoteURL?: string
  readonly provider?: "github" | "gitlab"
  readonly title: string
  readonly findingIDs: readonly string[]
  readonly proofs: readonly PublishProof[]
  readonly changedFiles: readonly string[]
  readonly patch: {
    readonly path: "reports/remediation.patch"
    readonly sha256: string
    readonly bytes: number
  }
}

export interface GitToolHooks {
  readonly confirmPublish: (candidate: PublishCandidate) => Promise<boolean>
  readonly fixedFindings: (ids: readonly string[]) => Promise<{ ok: boolean; unresolved: readonly string[] }>
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

interface CommandOptions {
  readonly timeoutMs?: number
  readonly limit?: number
  readonly environment?: Readonly<Record<string, string>>
}

async function command(argv: readonly string[], cwd: string, options?: CommandOptions) {
  const environment = { ...(options?.environment ?? process.env) }
  delete environment.CYBERFUL_REMEDIATION_PROOF_KEY
  delete environment.CYBERFUL_CODE_GRAPH_LEDGER_KEY
  const child = Bun.spawn([...argv], { cwd, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const timer = setTimeout(
    () => {
      timedOut = true
      child.kill("SIGKILL")
    },
    Math.max(1, options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS),
  )
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, options?.limit ?? MAX_GIT_OUTPUT),
      readBounded(child.stderr, options?.limit ?? MAX_GIT_OUTPUT),
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

// ── Local Git Never Inherits A Network-Capable Environment ──────
// Repository configuration is untrusted input: a partial clone can fetch a
// missing object during an otherwise read-only diff, while filters, credential
// helpers, proxies, askpass programs, or injected GIT_CONFIG_* entries can turn
// local preparation into network or process activity. Offline Git receives a
// small operating-system allowlist plus explicit no-fetch/no-prompt controls;
// command-line policy disables transports, LFS drivers, hooks, and auto tasks.
//
// ─────────────────────────────────────────────────────────────────

export function offlineGitEnvironment(inherited: Readonly<Record<string, string | undefined>> = process.env) {
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

export function publishGitEnvironment(inherited: Readonly<Record<string, string | undefined>> = process.env) {
  return Object.fromEntries(
    Object.entries(inherited).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("CYBERFUL_") && !entry[0].startsWith("GIT_CONFIG_"),
    ),
  )
}

const MAX_ATTRIBUTE_FILES = 2_000
const MAX_ATTRIBUTE_BYTES = 1024 * 1024
const FILTER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

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

async function offlineGitFilterArgs(context: GitContext, cwd: string) {
  const names = new Set(["lfs"])
  const directories = [cwd]
  let attributeFiles = 0
  while (directories.length > 0) {
    const directory = directories.pop()
    if (!directory) break
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isSymbolicLink() || entry.name === ".git") continue
      if (entry.isDirectory()) {
        if (isContained(context.workareaRoot, candidate) && !isContained(context.workareaRoot, cwd)) continue
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

async function git(
  context: GitContext,
  args: readonly string[],
  cwd = context.sourceRoot,
  options?: { timeoutMs?: number; limit?: number },
) {
  const filterArgs = await offlineGitFilterArgs(context, cwd)
  return command(["git", ...COMMON_GIT_ARGS, ...OFFLINE_GIT_ARGS, ...filterArgs, ...args], cwd, {
    ...options,
    environment: offlineGitEnvironment(),
  })
}

async function publishGit(args: readonly string[], cwd: string, options?: Pick<CommandOptions, "timeoutMs" | "limit">) {
  return command(["git", ...COMMON_GIT_ARGS, ...args], cwd, {
    ...options,
    environment: {
      ...publishGitEnvironment(),
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  })
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

async function remediationCommitIdentity(context: GitContext, checkout: string) {
  const [configuredName, configuredEmail] = await Promise.all([
    git(context, ["config", "--local", "--get", "user.name"], checkout),
    git(context, ["config", "--local", "--get", "user.email"], checkout),
  ])
  const value = (result: CommandResult, fallback: string, limit: number) => {
    const candidate = result.exitCode === 0 ? result.stdout.trim() : ""
    return candidate && candidate.length <= limit && !/[\0\r\n]/.test(candidate) ? candidate : fallback
  }
  return {
    name: value(configuredName, "Cyberful", 200),
    email: value(configuredEmail, "cyberful@localhost", 320),
  }
}

async function repositoryRoot(context: GitContext) {
  const root = requireSuccess(await git(context, ["rev-parse", "--show-toplevel"]), "Git repository discovery")
  const resolved = await realpath(root)
  const source = await realpath(context.sourceRoot)
  if (!isContained(resolved, source)) throw new Error("source root is outside the discovered Git repository")
  requireSuccess(await git(context, ["rev-parse", "--verify", "HEAD^{commit}"]), "HEAD verification")
  return resolved
}

async function localCommit(context: GitContext, ref: string) {
  if (!ref || ref.startsWith("-")) throw new Error("Git ref must be a non-option local ref")
  const result = await git(context, ["rev-parse", "--verify", `${ref}^{commit}`])
  return requireSuccess(result, `Local ref '${ref}' verification`)
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

async function untrackedFiles(context: GitContext, excludedPathspecs: readonly string[]) {
  const result = await git(context, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ".",
    ...excludedPathspecs,
  ])
  requireComplete(result, "Untracked file inventory")
  const files = result.stdout.split("\0").filter(Boolean).sort()
  if (files.length > MAX_REVIEW_UNTRACKED_FILES)
    throw new Error("Untracked file inventory contains too many files for a bounded review")
  return files
}

// ── Cyberful-Owned Paths Never Become Review Input ──────────────
// Secure Review runs from a workarea and writes transcripts below the same
// checkout it inspects. Those host-owned roots are operational state, not user
// changes, so every Git inventory applies exact top-level exclusions derived
// from the canonical runtime paths. A tracked collision fails closed instead
// of silently hiding a project file that merely shares Cyberful's path.
//
// ─────────────────────────────────────────────────────────────────
function reviewOwnedRoots(context: GitContext) {
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

function excludedReviewPathspecs(roots: readonly string[]) {
  return roots.flatMap((root) => [`:(top,exclude)${root}`, `:(top,exclude)${root}/**`])
}

async function rejectTrackedOwnedRoots(context: GitContext, roots: readonly string[]) {
  if (roots.length === 0) return
  const result = await git(context, ["ls-files", "-z", "--", ...roots])
  const tracked = requireComplete(result, "Cyberful-owned path collision check").split("\0").filter(Boolean)
  if (tracked.length > 0)
    throw new Error(
      `Cyberful-owned runtime paths collide with tracked project files: ${tracked.slice(0, 10).join(", ")}`,
    )
}

function porcelainStatus(output: string) {
  const tokens = output.split("\0")
  if (tokens.at(-1) === "") tokens.pop()
  const entries: Array<{ code: string; path: string; original_path?: string }> = []
  for (let index = 0; index < tokens.length; index++) {
    const record = tokens[index]
    if (!record || record.length < 4 || record[2] !== " ") throw new Error("Git returned malformed porcelain status")
    const code = record.slice(0, 2)
    const file = record.slice(3)
    if (!file || file.includes("\0")) throw new Error("Git returned an unsafe porcelain path")
    if (code.includes("R") || code.includes("C")) {
      const original = tokens[++index]
      if (!original || original.includes("\0")) throw new Error("Git returned a malformed rename status")
      entries.push({ code, path: file, original_path: original })
    } else entries.push({ code, path: file })
  }
  return entries
}

function safeWorkareaPath(context: GitContext, ...segments: string[]) {
  const candidate = path.join(context.workareaRoot, ...segments)
  if (!isContained(context.workareaRoot, candidate)) throw new Error("derived path escapes the workarea")
  return candidate
}

async function ensurePlainWorkareaDirectory(context: GitContext, relative: string) {
  let current = context.workareaRoot
  for (const segment of relative.split("/").filter(Boolean)) {
    current = path.join(current, segment)
    const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!existing) await mkdir(current, { mode: 0o700 })
    const created = await lstat(current)
    if (!created.isDirectory() || created.isSymbolicLink())
      throw new Error(`workarea path '${relative}' contains a non-directory or symlink`)
    const resolved = await realpath(current)
    if (!isContained(context.workareaRoot, resolved)) throw new Error(`workarea path '${relative}' escapes its root`)
  }
  return current
}

async function requirePlainWorkareaDirectory(context: GitContext, relative: string) {
  let current = context.workareaRoot
  for (const segment of relative.split("/").filter(Boolean)) {
    current = path.join(current, segment)
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info?.isDirectory() || info.isSymbolicLink())
      throw new Error(`workarea path '${relative}' is missing or contains a non-directory or symlink`)
    const resolved = await realpath(current)
    if (!isContained(context.workareaRoot, resolved)) throw new Error(`workarea path '${relative}' escapes its root`)
  }
  return current
}

// ── Review Is An Overlay, Not A Fetch ─────────────────────────────
// Review preparation resolves only refs already present in the local object
// database. The patch from merge-base to the working tree naturally includes
// committed, staged, and unstaged changes; untracked files are appended as
// explicit no-index patches so the review snapshot matches what the user sees.
//
// ─────────────────────────────────────────────────────────────────

async function prepareReview(context: GitContext, args: Record<string, unknown>) {
  await repositoryRoot(context)
  const excludedOwnedRoots = reviewOwnedRoots(context)
  const excludedPathspecs = excludedReviewPathspecs(excludedOwnedRoots)
  await rejectTrackedOwnedRoots(context, excludedOwnedRoots)
  const explicitBase = typeof args.base_ref === "string" ? args.base_ref.trim() : undefined
  const explicitHead = typeof args.head_ref === "string" ? args.head_ref.trim() : undefined
  const head = await localCommit(context, explicitHead || "HEAD")
  const branchBase = await localCommit(context, explicitBase || (await defaultBranch(context)))
  const base = requireSuccess(await git(context, ["merge-base", branchBase, head]), "Merge-base resolution")
  const branch = (await git(context, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim() || undefined
  const diffArgs = explicitHead
    ? ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", base, head, "--", ".", ...excludedPathspecs]
    : ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", base, "--", ".", ...excludedPathspecs]
  const patchResult = await git(context, diffArgs, context.sourceRoot, { limit: MAX_REVIEW_PATCH_BYTES })
  requireComplete(patchResult, "Review patch generation")
  const statusResult = await git(context, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ".",
    ...excludedPathspecs,
  ])
  requireComplete(statusResult, "Review status")
  const untracked =
    args.include_untracked === false || explicitHead ? [] : await untrackedFiles(context, excludedPathspecs)
  const changedResult = await git(
    context,
    explicitHead
      ? ["diff", "--name-only", "-z", "--no-renames", base, head, "--", ".", ...excludedPathspecs]
      : ["diff", "--name-only", "-z", "--no-renames", base, "--", ".", ...excludedPathspecs],
  )
  const reviewableFiles = [
    ...new Set([...requireComplete(changedResult, "Review file inventory").split("\0").filter(Boolean), ...untracked]),
  ].sort()
  let patchText = patchResult.stdout
  let patchBytes = Buffer.byteLength(patchText)
  for (const file of untracked) {
    const separator = patchText ? "\n" : ""
    const remaining = MAX_REVIEW_PATCH_BYTES - patchBytes - Buffer.byteLength(separator)
    if (remaining < 0) throw new Error("Review patch exceeds its aggregate host byte limit")
    const patch = await git(
      context,
      ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--binary", "--", "/dev/null", file],
      context.sourceRoot,
      { limit: remaining + 1 },
    )
    if (patch.exitCode !== 0 && patch.exitCode !== 1) requireSuccess(patch, `Untracked patch for '${file}'`)
    const additionBytes = Buffer.byteLength(patch.stdout)
    if (patch.truncated || additionBytes > remaining)
      throw new Error("Review patch exceeds its aggregate host byte limit")
    if (patch.stdout) {
      patchText += separator + patch.stdout
      patchBytes += Buffer.byteLength(separator) + additionBytes
    }
  }
  await ensurePlainWorkareaDirectory(context, "raw/secure-review")
  await replaceWorkareaFile(context.workareaRoot, "raw/secure-review/changes.patch", patchText)
  const manifest = {
    version: 2,
    review_status: reviewableFiles.length > 0 ? "ready" : "empty",
    base,
    head,
    branch,
    includes_working_tree: !explicitHead,
    untracked,
    reviewable_files: reviewableFiles,
    excluded_owned_roots: excludedOwnedRoots,
    status: porcelainStatus(statusResult.stdout),
    patch_sha256: createHash("sha256").update(patchText).digest("hex"),
    patch_bytes: patchBytes,
    patch_limit_bytes: MAX_REVIEW_PATCH_BYTES,
    patch_truncated: false,
    created_at: new Date().toISOString(),
  }
  await replaceWorkareaFile(
    context.workareaRoot,
    "raw/secure-review/manifest.json",
    JSON.stringify(manifest, null, 2) + "\n",
  )
  return {
    ...manifest,
    patch_path: "raw/secure-review/changes.patch",
    manifest_path: "raw/secure-review/manifest.json",
  }
}

async function remediationState(context: GitContext) {
  const root = safeWorkareaPath(context, "remediation")
  const checkout = path.join(root, "checkout")
  const manifestPath = path.join(root, "manifest.json")
  return { root, checkout, manifestPath }
}

interface RemediationManifestPayload {
  readonly version: 1
  readonly session_id: string
  readonly repository_root_sha256: string
  readonly branch: string
  readonly base: string
  readonly checkout: "remediation/checkout"
  readonly excluded_dirty_paths: readonly string[]
  readonly created_at: string
}

interface RemediationManifest extends RemediationManifestPayload {
  readonly attestation: string
}

const REMEDIATION_BRANCH_PATTERN = /^cyberful\/remediate\/[a-z0-9][a-z0-9-]{0,79}$/
const GIT_OBJECT_ID_PATTERN = /^[a-f0-9]{40,64}$/

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function remediationManifestAttestation(payload: RemediationManifestPayload, key: string) {
  return createHmac("sha256", key)
    .update("cyberful-remediation-manifest-v1\0")
    .update(JSON.stringify(payload))
    .digest("hex")
}

function remediationManifestPayload(value: unknown): RemediationManifestPayload | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (
    input.version !== 1 ||
    typeof input.session_id !== "string" ||
    !input.session_id ||
    input.session_id.length > 500 ||
    typeof input.repository_root_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.repository_root_sha256) ||
    typeof input.branch !== "string" ||
    !REMEDIATION_BRANCH_PATTERN.test(input.branch) ||
    typeof input.base !== "string" ||
    !GIT_OBJECT_ID_PATTERN.test(input.base) ||
    input.checkout !== "remediation/checkout" ||
    !Array.isArray(input.excluded_dirty_paths) ||
    input.excluded_dirty_paths.length > MAX_FINGERPRINT_FILES ||
    input.excluded_dirty_paths.some(
      (item) => typeof item !== "string" || !item || item.length > 4_096 || item.includes("\0"),
    ) ||
    typeof input.created_at !== "string" ||
    !Number.isFinite(Date.parse(input.created_at))
  )
    return
  return {
    version: 1,
    session_id: input.session_id,
    repository_root_sha256: input.repository_root_sha256,
    branch: input.branch,
    base: input.base,
    checkout: "remediation/checkout",
    excluded_dirty_paths: input.excluded_dirty_paths,
    created_at: input.created_at,
  }
}

function validRemediationManifest(value: unknown, key: string) {
  const payload = remediationManifestPayload(value)
  if (!payload || typeof value !== "object" || value === null || Array.isArray(value)) return
  const attestation = (value as Record<string, unknown>).attestation
  if (typeof attestation !== "string" || !/^[a-f0-9]{64}$/.test(attestation)) return
  const expected = Buffer.from(remediationManifestAttestation(payload, key), "hex")
  const actual = Buffer.from(attestation, "hex")
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) return
  return { ...payload, attestation } satisfies RemediationManifest
}

async function readRegularJSON(file: string, description: string, limit = MAX_REMEDIATION_JSON_BYTES) {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${description} must be a regular host file`)
  if (info.size > limit) throw new Error(`${description} exceeds its host byte limit`)
  const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)))
  let content: string
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > limit) throw new Error(`${description} is not a bounded regular host file`)
    content = await handle.readFile({ encoding: "utf8" })
  } finally {
    await handle.close()
  }
  try {
    return JSON.parse(content) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${description} is not valid JSON`, { cause: error })
    throw error
  }
}

async function canonicalGitCommonDirectory(context: GitContext, cwd: string) {
  const raw = requireComplete(await git(context, ["rev-parse", "--git-common-dir"], cwd), "Git common directory")
  return realpath(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw))
}

async function deriveRemediationCheckout(context: GitContext, checkout: string) {
  const info = await lstat(checkout).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error("remediation_prepare must run first")
  const expectedRoot = await realpath(checkout)
  const actualRoot = await realpath(
    requireComplete(await git(context, ["rev-parse", "--show-toplevel"], checkout), "Remediation worktree root"),
  )
  if (actualRoot !== expectedRoot) throw new Error("remediation checkout is not the registered worktree root")
  const branch = requireComplete(
    await git(context, ["symbolic-ref", "--quiet", "--short", "HEAD"], checkout),
    "Remediation branch",
  )
  if (!REMEDIATION_BRANCH_PATTERN.test(branch)) throw new Error("remediation checkout is on an unsafe branch")
  const head = requireComplete(
    await git(context, ["rev-parse", "--verify", "HEAD^{commit}"], checkout),
    "Remediation HEAD",
  )
  if (!GIT_OBJECT_ID_PATTERN.test(head)) throw new Error("remediation checkout returned an invalid HEAD")
  return {
    root: actualRoot,
    branch,
    head,
    commonDirectory: await canonicalGitCommonDirectory(context, checkout),
  }
}

async function prepareRemediation(context: GitContext, args: Record<string, unknown>) {
  const repository = await repositoryRoot(context)
  const state = await remediationState(context)
  await ensurePlainWorkareaDirectory(context, "remediation")
  const existing = await lstat(state.manifestPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing) {
    const validated = await requireRemediationCheckout(context)
    return {
      version: 1,
      branch: validated.branch,
      base: validated.base,
      checkout: "remediation/checkout",
      excluded_dirty_paths: validated.excludedDirtyPaths,
      created_at: validated.createdAt,
      manifest_path: "remediation/manifest.json",
      reused: true,
    }
  }
  const rawSlug = typeof args.slug === "string" ? args.slug : "security-fixes"
  const slug =
    rawSlug
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "security-fixes"
  const suffix =
    context.sessionID
      .replace(/[^a-zA-Z0-9]+/g, "")
      .slice(-10)
      .toLowerCase() || "session"
  const branch = `cyberful/remediate/${slug}-${suffix}`
  if (!REMEDIATION_BRANCH_PATTERN.test(branch)) throw new Error("derived remediation branch is unsafe")
  const dirtyResult = await git(context, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."])
  requireComplete(dirtyResult, "Dirty checkout inventory")
  const dirty = porcelainStatus(dirtyResult.stdout)
  const checkoutInfo = await lstat(state.checkout).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (checkoutInfo) throw new Error("remediation checkout exists without a valid manifest")
  const base = await localCommit(context, "HEAD")
  requireSuccess(await git(context, ["worktree", "add", "-b", branch, state.checkout, "HEAD"]), "Remediation worktree")
  const derived = await deriveRemediationCheckout(context, state.checkout)
  if (derived.branch !== branch || derived.head !== base)
    throw new Error("created remediation worktree does not match its host-derived branch and base")
  const sourceCommonDirectory = await canonicalGitCommonDirectory(context, repository)
  if (derived.commonDirectory !== sourceCommonDirectory)
    throw new Error("created remediation checkout is not linked to the source repository")
  const payload: RemediationManifestPayload = {
    version: 1,
    session_id: context.sessionID,
    repository_root_sha256: sha256(repository),
    branch,
    base,
    checkout: "remediation/checkout",
    excluded_dirty_paths: [
      ...new Set(
        dirty.flatMap((entry) =>
          [entry.path, entry.original_path].filter((value): value is string => typeof value === "string"),
        ),
      ),
    ].sort(),
    created_at: new Date().toISOString(),
  }
  const manifest: RemediationManifest = {
    ...payload,
    attestation: remediationManifestAttestation(payload, remediationProofKey()),
  }
  await replaceWorkareaFile(context.workareaRoot, "remediation/manifest.json", JSON.stringify(manifest, null, 2) + "\n")
  return { ...payload, manifest_path: "remediation/manifest.json", reused: false }
}

async function requireRemediationCheckout(context: GitContext) {
  const state = await remediationState(context)
  await requirePlainWorkareaDirectory(context, "remediation")
  const manifest = validRemediationManifest(
    await readRegularJSON(state.manifestPath, "remediation manifest", MAX_REMEDIATION_MANIFEST_BYTES),
    remediationProofKey(),
  )
  if (!manifest) throw new Error("remediation manifest has an invalid host attestation")
  if (manifest.session_id !== context.sessionID) throw new Error("remediation manifest belongs to another session")
  const repository = await repositoryRoot(context)
  if (manifest.repository_root_sha256 !== sha256(repository))
    throw new Error("remediation manifest belongs to another source repository")
  const derived = await deriveRemediationCheckout(context, state.checkout)
  if (derived.branch !== manifest.branch) throw new Error("remediation branch differs from the authenticated manifest")
  const sourceCommonDirectory = await canonicalGitCommonDirectory(context, repository)
  if (derived.commonDirectory !== sourceCommonDirectory)
    throw new Error("remediation checkout is not linked to the authenticated source repository")
  const base = await git(context, ["cat-file", "-e", `${manifest.base}^{commit}`], state.checkout)
  requireComplete(base, "Authenticated remediation base")
  const ancestry = await git(context, ["merge-base", "--is-ancestor", manifest.base, derived.head], state.checkout)
  if (ancestry.exitCode !== 0)
    throw new Error("remediation HEAD no longer descends from the authenticated remediation base")
  return {
    ...state,
    branch: derived.branch,
    base: manifest.base,
    head: derived.head,
    excludedDirtyPaths: manifest.excluded_dirty_paths,
    createdAt: manifest.created_at,
  }
}

function fingerprintField(hash: ReturnType<typeof createHash>, value: string | Uint8Array) {
  const bytes = typeof value === "string" ? Buffer.from(value) : value
  hash.update(String(bytes.byteLength)).update(":").update(bytes).update("\0")
}

function emptyRemediationFingerprint() {
  const hash = createHash("sha256")
  fingerprintField(hash, "cyberful-remediation-tree-v1")
  return hash.digest("hex")
}

async function containedFingerprintPath(checkout: string, relative: string) {
  const normalized = relative.replaceAll("\\", "/")
  const segments = normalized.split("/")
  if (!normalized || path.posix.isAbsolute(normalized) || segments.some((segment) => !segment || segment === ".."))
    throw new Error("Git returned an unsafe remediation path")
  const candidate = path.resolve(checkout, ...segments)
  if (!isContained(checkout, candidate)) throw new Error("remediation fingerprint path escapes its checkout")
  let current = checkout
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment)
    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!metadata) break
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error(`remediation fingerprint path has an unsafe parent: ${relative}`)
    if (!isContained(checkout, await realpath(current)))
      throw new Error(`remediation fingerprint path escapes through a parent: ${relative}`)
  }
  return candidate
}

// Bind host-attested test results to the exact Git delta they exercised. Hashing only paths changed
// from the immutable remediation base keeps this proportional to the fix rather than to repository size,
// while remaining stable before and after the host creates the remediation commit.
async function remediationTreeFingerprint(context: GitContext, checkout: string, base: string) {
  const changed = await git(
    context,
    ["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", base, "--", "."],
    checkout,
    { limit: MAX_GIT_OUTPUT },
  )
  requireSuccess(changed, "Remediation fingerprint change inventory")
  const untracked = await git(context, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], checkout, {
    limit: MAX_GIT_OUTPUT,
  })
  requireSuccess(untracked, "Remediation fingerprint untracked inventory")
  if (changed.truncated || untracked.truncated) throw new Error("remediation fingerprint inventory exceeded its limit")
  const files = [...new Set([...changed.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean))].sort()
  if (files.length > MAX_FINGERPRINT_FILES) throw new Error("remediation fingerprint contains too many changed files")

  const hash = createHash("sha256")
  fingerprintField(hash, "cyberful-remediation-tree-v1")
  let totalBytes = 0
  for (const relative of files) {
    const candidate = await containedFingerprintPath(checkout, relative)
    const metadata = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    fingerprintField(hash, relative)
    if (!metadata) {
      fingerprintField(hash, "deleted")
      continue
    }
    if (metadata.isSymbolicLink()) {
      fingerprintField(hash, "symlink")
      fingerprintField(hash, await readlink(candidate))
      continue
    }
    if (metadata.isDirectory()) {
      const staged = await git(context, ["ls-files", "--stage", "--", relative], checkout)
      fingerprintField(hash, "gitlink")
      fingerprintField(hash, requireSuccess(staged, `Remediation gitlink '${relative}'`))
      continue
    }
    if (!metadata.isFile()) throw new Error(`remediation fingerprint rejects non-regular file '${relative}'`)
    if (metadata.size > MAX_FINGERPRINT_FILE_BYTES)
      throw new Error(`remediation fingerprint file exceeds its limit: ${relative}`)
    totalBytes += metadata.size
    if (totalBytes > MAX_FINGERPRINT_TOTAL_BYTES) throw new Error("remediation fingerprint byte limit exceeded")
    const handle = await open(
      candidate,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
    )
    const bytes = await handle.readFile().finally(() => handle.close())
    fingerprintField(hash, metadata.mode & 0o111 ? "executable" : "file")
    fingerprintField(hash, bytes)
  }
  return hash.digest("hex")
}

// ── Fix Proofs Bind Model-Selected Oracles To One Named Case ────
// The model owns test semantics and may select different pre/post harnesses.
// The host binds both observations to the same named case and exact finding set,
// while signing each command and result separately. This preserves evidence
// continuity without prescribing an exit-code convention or executable.
// ─────────────────────────────────────────────────────────────────

const REMEDIATION_CONTAINER_CHECKOUT = "/workspace/remediation/checkout"

function normalizedRemediationCommand(command: readonly string[]) {
  return command.map((argument) => {
    let normalized = argument
    while (normalized.includes(`${REMEDIATION_CONTAINER_CHECKOUT}/./`))
      normalized = normalized.replaceAll(`${REMEDIATION_CONTAINER_CHECKOUT}/./`, `${REMEDIATION_CONTAINER_CHECKOUT}/`)
    if (normalized.endsWith(`${REMEDIATION_CONTAINER_CHECKOUT}/.`)) normalized = normalized.slice(0, -2)
    if (normalized.endsWith(`${REMEDIATION_CONTAINER_CHECKOUT}/`)) normalized = normalized.slice(0, -1)
    return normalized
  })
}

function remediationCommandIdentity(command: readonly string[]) {
  return sha256(JSON.stringify(normalizedRemediationCommand(command)))
}

function remediationCaseIdentityV2(testCase: string, commandIdentitySha256: string, findingIDs: readonly string[]) {
  return sha256(
    `cyberful-remediation-case-v2\0${JSON.stringify({
      test_case: testCase,
      command_identity_sha256: commandIdentitySha256,
      finding_ids: [...findingIDs].sort(),
    })}`,
  )
}

function remediationCaseIdentity(testCase: string, findingIDs: readonly string[]) {
  return sha256(
    `cyberful-remediation-case-v3\0${JSON.stringify({
      test_case: testCase,
      finding_ids: [...findingIDs].sort(),
    })}`,
  )
}

interface RemediationAttestationPayload {
  readonly version: 2 | 3
  readonly command: readonly string[]
  readonly test_case: string
  readonly command_sha256: string
  readonly command_identity_sha256: string
  readonly case_sha256: string
  readonly stage: "pre-fix" | "post-fix" | "regression"
  readonly finding_ids: readonly string[]
  readonly expected_exit_codes: readonly number[]
  readonly exit_code: number
  readonly expectation_met: boolean
  readonly output_sha256: string
  readonly tree_fingerprint: string
  readonly created_at: string
}

function remediationAttestation(payload: RemediationAttestationPayload, key: string) {
  return createHmac("sha256", key)
    .update(`cyberful-remediation-test-v${payload.version}\0`)
    .update(JSON.stringify(payload))
    .digest("hex")
}

async function testRemediation(context: GitContext, args: Record<string, unknown>) {
  const state = await requireRemediationCheckout(context)
  if (!Array.isArray(args.command) || args.command.length < 1 || args.command.length > 64)
    throw new Error("remediation_test command must contain 1-64 argv entries")
  const argv = args.command.map((value) => {
    if (typeof value !== "string" || !value || value.length > 4_096 || value.includes("\0"))
      throw new Error("remediation_test command contains an invalid argv entry")
    return value
  })
  const stage = args.stage
  if (stage !== "pre-fix" && stage !== "post-fix" && stage !== "regression")
    throw new Error("remediation_test stage must be pre-fix, post-fix, or regression")
  if (
    typeof args.test_case !== "string" ||
    !args.test_case.trim() ||
    args.test_case.length > 200 ||
    /[\0\r\n]/.test(args.test_case)
  )
    throw new Error("remediation_test test_case must be a non-empty single-line case identity")
  const testCase = args.test_case.trim()
  const findingIDs = requestedFindingIDs(args.finding_ids)
  if (
    !Array.isArray(args.expected_exit_codes) ||
    args.expected_exit_codes.length < 1 ||
    args.expected_exit_codes.length > 16
  )
    throw new Error("remediation_test expected_exit_codes must contain 1-16 values")
  const expectedExitCodes = args.expected_exit_codes.map((value) => {
    if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 255)
      throw new Error("remediation_test expected exit code must be between 0 and 255")
    return Number(value)
  })
  if (stage === "pre-fix") {
    const status = requireSuccess(await git(context, ["status", "--porcelain=v1"], state.checkout), "Pre-fix status")
    const head = requireSuccess(await git(context, ["rev-parse", "HEAD"], state.checkout), "Pre-fix HEAD")
    if (status || head !== state.base)
      throw new Error("pre-fix reproduction requires the clean remediation base before any source change")
  }
  const timeoutMs = Number.isInteger(args.timeout_ms)
    ? Math.min(MAX_TEST_TIMEOUT_MS, Math.max(1_000, Number(args.timeout_ms)))
    : MAX_TEST_TIMEOUT_MS
  const container = process.env.CYBERFUL_OS_CONTAINER?.trim()
  if (!container) throw new Error("the isolated cyberful-os container is unavailable")
  const treeFingerprint = await remediationTreeFingerprint(context, state.checkout, state.base)
  if (stage !== "pre-fix" && treeFingerprint === emptyRemediationFingerprint())
    throw new Error("post-fix verification requires a Git delta from the remediation base")
  const commandSha256 = sha256(JSON.stringify(argv))
  const commandIdentitySha256 = remediationCommandIdentity(argv)
  const caseSha256 = remediationCaseIdentity(testCase, findingIDs)
  if (stage === "post-fix") {
    const testsDirectory = safeWorkareaPath(context, "raw", "remediation", "tests")
    const testsMetadata = await lstat(testsDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    const priorTests = testsMetadata ? await remediationTestRecords(context) : []
    const reproduced = priorTests.some(
      (test) => test.stage === "pre-fix" && test.expectationMet && test.caseSha256 === caseSha256,
    )
    if (!reproduced)
      throw new Error(
        "post-fix verification must reuse the same named case and finding set from a successful pre-fix reproduction",
      )
  }
  const startedAt = Date.now()
  const result = await command(
    ["docker", "exec", "-w", "/workspace/remediation/checkout", container, "env", "CI=1", ...argv],
    context.workareaRoot,
    { timeoutMs, limit: MAX_TEST_OUTPUT },
  )
  const endedAt = Date.now()
  const fingerprintAfterTest = await remediationTreeFingerprint(context, state.checkout, state.base)
  if (fingerprintAfterTest !== treeFingerprint)
    throw new Error("remediation_test modified the Git delta; restore it and rerun verification")
  const outputSha256 = createHash("sha256").update(result.stdout).update("\0").update(result.stderr).digest("hex")
  const createdAt = new Date(startedAt).toISOString()
  const attestationPayload: RemediationAttestationPayload = {
    version: 3,
    command: argv,
    test_case: testCase,
    command_sha256: commandSha256,
    command_identity_sha256: commandIdentitySha256,
    case_sha256: caseSha256,
    stage,
    finding_ids: findingIDs,
    expected_exit_codes: expectedExitCodes,
    exit_code: result.exitCode,
    expectation_met: expectedExitCodes.includes(result.exitCode),
    output_sha256: outputSha256,
    tree_fingerprint: treeFingerprint,
    created_at: createdAt,
  }
  const record = {
    ...attestationPayload,
    duration_ms: endedAt - startedAt,
    timed_out: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    output_truncated: result.truncated,
    attestation: remediationAttestation(attestationPayload, remediationProofKey()),
  }
  await ensurePlainWorkareaDirectory(context, "raw/remediation/tests")
  const relativeFile = `raw/remediation/tests/${startedAt}-${stage}-${caseSha256.slice(0, 8)}.json`
  await replaceWorkareaFile(context.workareaRoot, relativeFile, JSON.stringify(record, null, 2) + "\n")
  await replaceWorkareaFile(
    context.workareaRoot,
    "raw/remediation/tests/latest.json",
    JSON.stringify(record, null, 2) + "\n",
  )
  return {
    ...record,
    stdout: result.stdout.slice(0, 16_000),
    stderr: result.stderr.slice(0, 16_000),
    record_path: relativeFile,
  }
}

async function executable(name: string) {
  try {
    const result = await command([name, "--version"], process.cwd(), { timeoutMs: 5_000, limit: 8_192 })
    return result.exitCode === 0
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false
    throw error
  }
}

async function recordPublication(context: GitContext, value: Record<string, unknown>) {
  await replaceWorkareaFile(
    context.workareaRoot,
    "reports/remediation-publish.json",
    JSON.stringify({ ...value, recorded_at: new Date().toISOString() }, null, 2) + "\n",
  )
  return { ...value, record_path: "reports/remediation-publish.json" }
}

interface RemediationTestRecord {
  readonly command: readonly string[]
  readonly testCase: string
  readonly commandSha256: string
  readonly commandIdentitySha256: string
  readonly caseSha256: string
  readonly stage: "pre-fix" | "post-fix" | "regression"
  readonly findingIDs: readonly string[]
  readonly expectedExitCodes: readonly number[]
  readonly exitCode: number
  readonly expectationMet: boolean
  readonly outputSha256: string
  readonly treeFingerprint: string
  readonly createdAt: string
}

function remediationTestRecord(value: unknown, key: string): RemediationTestRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (input.version !== 2 && input.version !== 3) return
  const version = input.version
  if (input.stage !== "pre-fix" && input.stage !== "post-fix" && input.stage !== "regression") return
  if (
    !Array.isArray(input.command) ||
    input.command.length < 1 ||
    input.command.length > 64 ||
    input.command.some((item) => typeof item !== "string" || !item || item.length > 4_096 || item.includes("\0"))
  )
    return
  if (
    !Array.isArray(input.finding_ids) ||
    input.finding_ids.length < 1 ||
    input.finding_ids.length > 200 ||
    input.finding_ids.some((item) => typeof item !== "string" || !item || item.length > 200 || /[\0\r\n]/.test(item)) ||
    new Set(input.finding_ids).size !== input.finding_ids.length
  )
    return
  if (
    !Array.isArray(input.expected_exit_codes) ||
    input.expected_exit_codes.length < 1 ||
    input.expected_exit_codes.length > 16 ||
    input.expected_exit_codes.some((item) => !Number.isInteger(item) || Number(item) < 0 || Number(item) > 255)
  )
    return
  if (!Number.isInteger(input.exit_code) || typeof input.expectation_met !== "boolean") return
  if (
    typeof input.test_case !== "string" ||
    !input.test_case ||
    input.test_case.length > 200 ||
    /[\0\r\n]/.test(input.test_case) ||
    input.test_case !== input.test_case.trim() ||
    typeof input.command_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.command_sha256) ||
    typeof input.command_identity_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.command_identity_sha256) ||
    typeof input.case_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.case_sha256) ||
    typeof input.output_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.output_sha256) ||
    typeof input.tree_fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.tree_fingerprint) ||
    typeof input.created_at !== "string" ||
    !Number.isFinite(Date.parse(input.created_at)) ||
    typeof input.attestation !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.attestation)
  )
    return
  const expectedExitCodes = input.expected_exit_codes.map(Number)
  const exitCode = Number(input.exit_code)
  if (input.expectation_met !== expectedExitCodes.includes(exitCode)) return
  if (version === 2 && input.stage === "pre-fix" && (expectedExitCodes.includes(0) || exitCode === 0)) return
  if (version === 2 && input.stage !== "pre-fix" && (expectedExitCodes.length !== 1 || expectedExitCodes[0] !== 0))
    return
  const commandSha256 = sha256(JSON.stringify(input.command))
  const commandIdentitySha256 = remediationCommandIdentity(input.command)
  const caseSha256 =
    version === 2
      ? remediationCaseIdentityV2(input.test_case, commandIdentitySha256, input.finding_ids)
      : remediationCaseIdentity(input.test_case, input.finding_ids)
  if (
    input.command_sha256 !== commandSha256 ||
    input.command_identity_sha256 !== commandIdentitySha256 ||
    input.case_sha256 !== caseSha256
  )
    return
  const payload: RemediationAttestationPayload = {
    version,
    command: input.command,
    test_case: input.test_case,
    command_sha256: commandSha256,
    command_identity_sha256: commandIdentitySha256,
    case_sha256: caseSha256,
    stage: input.stage,
    finding_ids: input.finding_ids,
    expected_exit_codes: expectedExitCodes,
    exit_code: exitCode,
    expectation_met: input.expectation_met,
    output_sha256: input.output_sha256,
    tree_fingerprint: input.tree_fingerprint,
    created_at: input.created_at,
  }
  const expected = Buffer.from(remediationAttestation(payload, key), "hex")
  const actual = Buffer.from(input.attestation, "hex")
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) return
  return {
    command: input.command,
    testCase: input.test_case,
    commandSha256,
    commandIdentitySha256,
    caseSha256,
    stage: input.stage,
    findingIDs: input.finding_ids,
    expectedExitCodes,
    exitCode,
    expectationMet: input.expectation_met,
    outputSha256: input.output_sha256,
    treeFingerprint: input.tree_fingerprint,
    createdAt: input.created_at,
  }
}

async function remediationTestRecords(context: GitContext) {
  const testsDirectory = await requirePlainWorkareaDirectory(context, "raw/remediation/tests")
  const testFiles = (await readdir(testsDirectory))
    .filter((file) => file.endsWith(".json") && file !== "latest.json")
    .sort()
  if (testFiles.length > MAX_REMEDIATION_TEST_RECORDS)
    throw new Error("remediation_test record inventory exceeds its host limit")
  const proofKey = remediationProofKey()
  const parsed = await Promise.all(
    testFiles.map(async (file) => {
      if (path.basename(file) !== file) return
      return remediationTestRecord(
        await readRegularJSON(path.join(testsDirectory, file), "remediation_test record"),
        proofKey,
      )
    }),
  )
  if (parsed.some((record) => record === undefined))
    throw new Error("a remediation_test record has an invalid host attestation")
  return parsed as RemediationTestRecord[]
}

function findingProofStatus(tests: readonly RemediationTestRecord[], findingID: string, treeFingerprint: string) {
  const reproductions = tests.filter(
    (test) => test.stage === "pre-fix" && test.findingIDs.includes(findingID) && test.expectationMet,
  )
  const verified = tests.some(
    (test) =>
      test.stage === "post-fix" &&
      test.findingIDs.includes(findingID) &&
      test.expectationMet &&
      test.treeFingerprint === treeFingerprint &&
      reproductions.some((reproduction) => reproduction.caseSha256 === test.caseSha256),
  )
  return { reproduced: reproductions.length > 0, verified }
}

function requestedFindingIDs(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200)
    throw new Error("finding_ids must contain 1-200 ids")
  const ids = value.map((item) => {
    if (typeof item !== "string" || !item || item.length > 200 || /[\0\r\n]/.test(item))
      throw new Error("finding_ids are invalid")
    return item
  })
  if (new Set(ids).size !== ids.length) throw new Error("finding_ids must not contain duplicates")
  return ids
}

interface CommitEvidence {
  readonly patchText: string
  readonly patchSha256: string
  readonly patchBytes: number
  readonly changedFiles: readonly string[]
}

async function remediationCommitEvidence(
  context: GitContext,
  checkout: string,
  base: string,
  commit: string,
): Promise<CommitEvidence> {
  const patch = await git(
    context,
    ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", base, commit, "--", "."],
    checkout,
    { limit: MAX_REMEDIATION_PATCH_BYTES },
  )
  requireSuccess(patch, "Final remediation patch")
  if (patch.truncated) throw new Error("Final remediation patch exceeded its host byte limit")
  const patchText = patch.stdout + (patch.stdout && !patch.stdout.endsWith("\n") ? "\n" : "")
  const changed = await git(
    context,
    ["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", base, commit, "--", "."],
    checkout,
    { limit: MAX_GIT_OUTPUT },
  )
  requireComplete(changed, "Final remediation changed-file inventory")
  const changedFiles = changed.stdout.split("\0").filter(Boolean)
  if (changedFiles.length > MAX_FINGERPRINT_FILES)
    throw new Error("Final remediation changed-file inventory exceeds its host limit")
  return {
    patchText,
    patchSha256: sha256(patchText),
    patchBytes: Buffer.byteLength(patchText),
    changedFiles,
  }
}

interface RemoteDescriptor {
  readonly url: string
  readonly displayURL: string
  readonly host?: string
  readonly provider?: "github" | "gitlab"
  readonly project?: string
}

function remoteDescriptor(raw: string): RemoteDescriptor {
  let host: string | undefined
  let project: string | undefined
  let displayURL = raw
  try {
    const parsed = new URL(raw)
    host = parsed.hostname.toLowerCase()
    project = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "")
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username === "git" ? "git" : "redacted"
      parsed.password = ""
      displayURL = parsed.toString()
    }
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    const scp = raw.match(/^(?:([^@/:\s]+)@)?([^/:\s]+):(.+)$/)
    if (scp) {
      host = scp[2]?.toLowerCase()
      project = scp[3]?.replace(/^\/+/, "").replace(/\.git$/, "")
      displayURL = `${scp[1] === "git" ? "git@" : ""}${scp[2]}:${scp[3]}`
    }
  }
  if (
    !project ||
    project.length > 500 ||
    /[\0\r\n]/.test(project) ||
    project.split("/").length < 2 ||
    project.split("/").some((segment) => !segment || segment === "." || segment === "..")
  )
    project = undefined
  const provider = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : undefined
  if (provider === "github" && project?.split("/").length !== 2) project = undefined
  return {
    url: raw,
    displayURL,
    ...(host ? { host } : {}),
    ...(provider ? { provider } : {}),
    ...(project ? { project } : {}),
  }
}

async function selectedRemote(context: GitContext, checkout: string, requested: unknown) {
  const inventory = await git(context, ["remote"], checkout)
  const remotes = requireComplete(inventory, "Remote inventory").split(/\r?\n/).filter(Boolean)
  if (remotes.some((remote) => remote.startsWith("-") || remote.length > 100 || /[\0\r\n]/.test(remote)))
    throw new Error("Git remote inventory contains an unsafe name")
  const requestedRemote = typeof requested === "string" && requested.trim() ? requested.trim() : undefined
  if (requestedRemote && !remotes.includes(requestedRemote)) throw new Error("no matching Git remote is available")
  const name = requestedRemote ?? (remotes.includes("origin") ? "origin" : remotes[0])
  if (!name) return
  const result = await git(context, ["remote", "get-url", "--push", name], checkout)
  const url = requireComplete(result, "Push remote URL")
  if (!url || url.length > 4_096 || /[\0\r\n]/.test(url)) throw new Error("Git push remote URL is invalid")
  return { name, descriptor: remoteDescriptor(url) }
}

function publishProofs(
  tests: readonly RemediationTestRecord[],
  findingIDs: readonly string[],
  treeFingerprint: string,
): PublishProof[] {
  const requested = new Set(findingIDs)
  return tests
    .filter(
      (test) =>
        test.expectationMet &&
        test.findingIDs.some((id) => requested.has(id)) &&
        (test.stage === "pre-fix" || test.treeFingerprint === treeFingerprint),
    )
    .map((test) => ({
      stage: test.stage,
      testCase: test.testCase,
      command: test.command,
      commandSha256: test.commandSha256,
      commandIdentitySha256: test.commandIdentitySha256,
      caseSha256: test.caseSha256,
      expectedExitCodes: test.expectedExitCodes,
      exitCode: test.exitCode,
      outputSha256: test.outputSha256,
      treeFingerprint: test.treeFingerprint,
      findingIDs: test.findingIDs.filter((id) => requested.has(id)),
      createdAt: test.createdAt,
    }))
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.stage.localeCompare(right.stage) ||
        left.commandSha256.localeCompare(right.commandSha256),
    )
}

async function publishRemediation(context: GitContext, args: Record<string, unknown>, hooks: GitToolHooks) {
  const state = await requireRemediationCheckout(context)
  if (typeof args.title !== "string" || !args.title.trim() || args.title.length > 200 || /[\0\r\n]/.test(args.title))
    throw new Error("remediation_publish requires a single-line title")
  if (
    typeof args.commit_message !== "string" ||
    !args.commit_message.trim() ||
    args.commit_message.length > 200 ||
    /[\0\r\n]/.test(args.commit_message)
  )
    throw new Error("remediation_publish requires commit_message")
  if (typeof args.body === "string" && args.body.length > 20_000)
    throw new Error("remediation_publish body is too long")
  const findingIDs = requestedFindingIDs(args.finding_ids)
  const findings = await hooks.fixedFindings(findingIDs)
  if (!findings.ok) throw new Error(`unresolved remediation findings: ${findings.unresolved.join(", ")}`)
  const tests = await remediationTestRecords(context)
  const currentFingerprint = await remediationTreeFingerprint(context, state.checkout, state.base)
  const missingProof = findingIDs.filter((id) => {
    const proof = findingProofStatus(tests, id, currentFingerprint)
    return !proof.reproduced || !proof.verified
  })
  if (missingProof.length)
    throw new Error(`pre-fix and post-fix remediation_test proof is required for: ${missingProof.join(", ")}`)
  const testsDirectory = await requirePlainWorkareaDirectory(context, "raw/remediation/tests")
  const latest = remediationTestRecord(
    await readRegularJSON(path.join(testsDirectory, "latest.json"), "latest remediation_test record"),
    remediationProofKey(),
  )
  if (!latest?.expectationMet || latest.stage === "pre-fix" || latest.treeFingerprint !== currentFingerprint)
    throw new Error("the latest host-attested post-fix remediation_test does not match the current Git delta")
  requireSuccess(await git(context, ["add", "--all"], state.checkout), "Staging remediation")
  const staged = await git(context, ["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv"], state.checkout)
  if (staged.exitCode === 1) {
    const identity = await remediationCommitIdentity(context, state.checkout)
    requireSuccess(
      await git(
        context,
        [
          "-c",
          `user.name=${identity.name}`,
          "-c",
          `user.email=${identity.email}`,
          "commit",
          "-m",
          args.commit_message.trim(),
        ],
        state.checkout,
      ),
      "Remediation commit",
    )
  } else if (staged.exitCode !== 0) requireSuccess(staged, "Staged remediation check")
  const status = requireSuccess(await git(context, ["status", "--porcelain=v1"], state.checkout), "Remediation status")
  if (status) throw new Error("remediation checkout must be clean before publication")
  const committedFingerprint = await remediationTreeFingerprint(context, state.checkout, state.base)
  if (committedFingerprint !== currentFingerprint)
    throw new Error("the remediation commit changed the host-attested Git delta; rerun post-fix verification")
  const commit = requireSuccess(await git(context, ["rev-parse", "HEAD"], state.checkout), "Remediation commit id")
  if (commit === state.base) throw new Error("remediation publication requires a source change from the recorded base")
  const evidence = await remediationCommitEvidence(context, state.checkout, state.base, commit)
  await replaceWorkareaFile(context.workareaRoot, "reports/remediation.patch", evidence.patchText)
  const remote = await selectedRemote(context, state.checkout, args.remote)
  const proofs = publishProofs(tests, findingIDs, currentFingerprint)
  const candidate: PublishCandidate = {
    branch: state.branch,
    commit,
    remote: remote?.name ?? "local-only",
    ...(remote ? { remoteURL: remote.descriptor.displayURL } : {}),
    ...(remote?.descriptor.provider ? { provider: remote.descriptor.provider } : {}),
    title: args.title.trim(),
    findingIDs,
    proofs,
    changedFiles: evidence.changedFiles,
    patch: {
      path: "reports/remediation.patch",
      sha256: evidence.patchSha256,
      bytes: evidence.patchBytes,
    },
  }
  if (!remote)
    return recordPublication(context, {
      published: false,
      branchPushed: false,
      reviewCreated: false,
      local: candidate,
      patch_path: "reports/remediation.patch",
      instructions: `No Git remote is configured; branch ${state.branch} and commit ${commit} remain local.`,
    })
  if (!(await hooks.confirmPublish(candidate)))
    return recordPublication(context, {
      published: false,
      branchPushed: false,
      reviewCreated: false,
      consentGranted: false,
      local: candidate,
      patch_path: "reports/remediation.patch",
    })

  // Consent binds the exact commit, patch, remote, and authenticated worktree state. Re-derive
  // them after the human answers so an intervening local mutation cannot inherit that consent.
  const confirmedState = await requireRemediationCheckout(context)
  const confirmedCommit = requireComplete(
    await git(context, ["rev-parse", "--verify", "HEAD^{commit}"], confirmedState.checkout),
    "Confirmed remediation commit",
  )
  const confirmedFingerprint = await remediationTreeFingerprint(context, confirmedState.checkout, confirmedState.base)
  const confirmedEvidence = await remediationCommitEvidence(
    context,
    confirmedState.checkout,
    confirmedState.base,
    confirmedCommit,
  )
  const confirmedRemote = await selectedRemote(context, confirmedState.checkout, remote.name)
  const confirmedTests = await remediationTestRecords(context)
  const confirmedProofs = publishProofs(confirmedTests, findingIDs, confirmedFingerprint)
  const confirmedFindings = await hooks.fixedFindings(findingIDs)
  if (
    confirmedState.branch !== candidate.branch ||
    confirmedCommit !== candidate.commit ||
    confirmedFingerprint !== currentFingerprint ||
    confirmedEvidence.patchSha256 !== candidate.patch.sha256 ||
    confirmedRemote?.descriptor.url !== remote.descriptor.url ||
    sha256(JSON.stringify(confirmedProofs)) !== sha256(JSON.stringify(candidate.proofs)) ||
    !confirmedFindings.ok
  )
    throw new Error("remediation publication state changed after consent; review and confirm again")

  const refspec = `refs/heads/${confirmedState.branch}:refs/heads/${confirmedState.branch}`
  const pushed = await publishGit(["push", "--set-upstream", "--", remote.name, refspec], confirmedState.checkout, {
    timeoutMs: 120_000,
  })
  if (pushed.exitCode !== 0)
    return recordPublication(context, {
      published: false,
      branchPushed: false,
      reviewCreated: false,
      consentGranted: true,
      provider: remote.descriptor.provider ?? "git",
      branch: confirmedState.branch,
      commit: confirmedCommit,
      pushExitCode: pushed.exitCode,
      error: (pushed.stderr || pushed.stdout).trim().slice(0, 16_000),
      outputTruncated: pushed.truncated,
      candidate,
      patch_path: "reports/remediation.patch",
    })

  await replaceWorkareaFile(
    context.workareaRoot,
    "raw/remediation/publish-body.md",
    typeof args.body === "string" ? args.body : "",
  )
  const bodyPath = safeWorkareaPath(context, "raw", "remediation", "publish-body.md")
  const provider = remote.descriptor.provider
  const project = remote.descriptor.project
  const manual = (reason: string) =>
    recordPublication(context, {
      published: true,
      branchPushed: true,
      reviewCreated: false,
      consentGranted: true,
      provider: provider ?? "git",
      remoteHost: remote.descriptor.host,
      branch: confirmedState.branch,
      commit: confirmedCommit,
      candidate,
      patch_path: "reports/remediation.patch",
      instructions: `${reason} Branch ${confirmedState.branch} was pushed to ${remote.name}; open a draft review manually.`,
    })
  if (!provider || !project) return manual("The push remote is not a supported github.com or gitlab.com project.")
  const adapter = provider === "gitlab" ? "glab" : "gh"
  if (!(await executable(adapter))) return manual(`${adapter} is not available on the host.`)
  if (provider === "gitlab") {
    const created = await command(
      [
        "glab",
        "mr",
        "create",
        "--repo",
        project,
        "--draft",
        "--title",
        candidate.title,
        "--description-file",
        bodyPath,
        "--source-branch",
        confirmedState.branch,
      ],
      confirmedState.checkout,
      { timeoutMs: 120_000 },
    )
    return recordPublication(context, {
      published: true,
      branchPushed: true,
      reviewCreated: created.exitCode === 0,
      consentGranted: true,
      provider: "gitlab",
      remoteHost: remote.descriptor.host,
      branch: confirmedState.branch,
      commit: confirmedCommit,
      output: created.stdout.trim(),
      adapter_exit_code: created.exitCode,
      adapterError: created.exitCode === 0 ? undefined : created.stderr.trim().slice(0, 16_000),
      outputTruncated: created.truncated,
      candidate,
      patch_path: "reports/remediation.patch",
      ...(created.exitCode === 0
        ? {}
        : { instructions: `Branch pushed to ${remote.name}; create the draft merge request manually.` }),
    })
  }
  const created = await command(
    [
      "gh",
      "pr",
      "create",
      "--repo",
      project,
      "--draft",
      "--title",
      candidate.title,
      "--body-file",
      bodyPath,
      "--head",
      confirmedState.branch,
    ],
    confirmedState.checkout,
    { timeoutMs: 120_000 },
  )
  return recordPublication(context, {
    published: true,
    branchPushed: true,
    reviewCreated: created.exitCode === 0,
    consentGranted: true,
    provider: "github",
    remoteHost: remote.descriptor.host,
    branch: confirmedState.branch,
    commit: confirmedCommit,
    output: created.stdout.trim(),
    adapter_exit_code: created.exitCode,
    adapterError: created.exitCode === 0 ? undefined : created.stderr.trim().slice(0, 16_000),
    outputTruncated: created.truncated,
    candidate,
    patch_path: "reports/remediation.patch",
    ...(created.exitCode === 0
      ? {}
      : { instructions: `Branch pushed to ${remote.name}; create the draft pull request manually.` }),
  })
}

async function canonicalGitContext(sessionID: string) {
  const context = contextFor(sessionID)
  if (!context) throw new Error("Git workflow tools require absolute source and workarea roots")
  const workareaRoot = await realpath(context.workareaRoot)
  const configuredSourceRoot = await realpath(context.sourceRoot)
  return {
    ...context,
    sourceRoot: await effectiveSourceRoot(configuredSourceRoot, workareaRoot),
    workareaRoot,
    ...(context.sessionLogRoot
      ? {
          sessionLogRoot: await realpath(context.sessionLogRoot).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return context.sessionLogRoot
            throw error
          }),
        }
      : {}),
  }
}

// The finding ledger may mark a remediation fixed only after this host-owned,
// read-only check confirms both sides of the proof against the current tree.
// It deliberately does not stage, commit, mutate the worktree, or publish.
export async function authorizeFixedFinding(
  sessionID: string,
  findingID: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const [validatedID] = requestedFindingIDs([findingID])
    if (!validatedID) return { ok: false, reason: "finding id is invalid" }
    const context = await canonicalGitContext(sessionID)
    const state = await requireRemediationCheckout(context)
    const tests = await remediationTestRecords(context)
    const fingerprint = await remediationTreeFingerprint(context, state.checkout, state.base)
    const proof = findingProofStatus(tests, validatedID, fingerprint)
    if (!proof.reproduced) return { ok: false, reason: "a signed pre-fix reproduction is required for this finding" }
    if (!proof.verified)
      return {
        ok: false,
        reason: "a signed post-fix proof matching the reproduced named case and finding set is required",
      }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "remediation proof verification failed" }
  }
}

export function gitToolsAvailable() {
  return contextFor("availability") !== undefined
}

export function isGitTool(name: string): name is GitToolName {
  return GIT_TOOL_DEFS.some((tool) => tool.name === name)
}

export async function handleGitTool(
  sessionID: string,
  name: GitToolName,
  args: Record<string, unknown>,
  hooks: GitToolHooks,
) {
  const canonical = await canonicalGitContext(sessionID)
  switch (name) {
    case "review_prepare":
      return prepareReview(canonical, args)
    case "remediation_prepare":
      return prepareRemediation(canonical, args)
    case "remediation_test":
      return testRemediation(canonical, args)
    case "remediation_publish":
      return publishRemediation(canonical, args, hooks)
  }
}
