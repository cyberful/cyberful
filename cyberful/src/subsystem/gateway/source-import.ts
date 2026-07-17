// ── Explicit Public Source Import ───────────────────────────────────────────
// Acquires one human-approved HTTPS Git source into a contained workarea,
// without hooks, credentials, submodules, LFS smudging, or implicit later
// fetches. The resolved commits and local ref mapping make offline analysis
// reproducible after this single visible network operation.
// → cyberful/src/subsystem/gateway/server.ts — owns the fixed human consent.
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path"
import os from "node:os"
import { isIP } from "node:net"
import { lookup } from "node:dns/promises"
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { constants as filesystemConstants } from "node:fs"
import { lstat, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm } from "node:fs/promises"
import { ensureWorkareaDirectory, replaceWorkareaFile } from "@/workarea"

const MAX_REFS = 8
const MAX_IMPORT_FILES = 1_000_000
const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024
const MAX_OUTPUT_BYTES = 512 * 1024
const IMPORT_TIMEOUT_MS = 15 * 60_000
const VERIFY_TIMEOUT_MS = 30_000
const MAX_MANIFEST_BYTES = 1024 * 1024
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/i
const SEALED_REF_PATTERN = /^refs\/cyberful\/(?:import-head|import\/[0-7])$/

export interface SourceTreeFingerprint {
  readonly algorithm: "sha256"
  readonly sha256: string
  readonly entries: number
  readonly files: number
  readonly bytes: number
  readonly excludes: readonly [".git"]
}

export interface SealedSourceRef {
  readonly requested_ref: string
  readonly local_ref: string
  readonly commit: string
}

interface SourceImportAttestation {
  readonly algorithm: "hmac-sha256"
  readonly hmac_sha256: string
}

export interface SourceImportManifest {
  readonly version: 2
  readonly url: string
  readonly host: string
  readonly checkout_ref?: string
  readonly additional_refs: readonly string[]
  readonly local_refs: Readonly<Record<string, string>>
  readonly sealed_refs: readonly SealedSourceRef[]
  readonly commit: string
  readonly tree: SourceTreeFingerprint
  readonly resolved_addresses: readonly string[]
  readonly files_on_disk: number
  readonly bytes_on_disk: number
  readonly network_complete: true
  readonly history_complete: boolean
  readonly hooks: false
  readonly submodules: false
  readonly lfs_smudge: false
  readonly dependencies: false
  readonly created_at: string
  readonly attestation: SourceImportAttestation
}

export type SourceImportManifestPayload = Omit<SourceImportManifest, "attestation">

export const SOURCE_IMPORT_TOOL_DEF = {
  name: "source_import",
  description:
    "Import one explicitly approved public HTTPS Git repository into an isolated snapshot. Records the resolved commit and optional refs, then all analysis continues offline. Hooks, credentials, submodules, LFS downloads, redirects, and dependency installation are disabled.",
  inputSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      url: { type: "string", minLength: 1, maxLength: 2_048 },
      checkout_ref: { type: "string", minLength: 1, maxLength: 200 },
      additional_refs: {
        type: "array",
        maxItems: MAX_REFS,
        items: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
    required: ["url"],
  },
} as const

export interface SourceImportRequest {
  readonly url: string
  readonly host: string
  readonly checkoutRef?: string
  readonly additionalRefs: readonly string[]
}

export interface SourceImportHooks {
  readonly confirm: (request: SourceImportRequest) => Promise<boolean>
  readonly resolveHost?: (host: string) => Promise<readonly string[]>
  readonly runGit?: (args: readonly string[], cwd: string) => Promise<CommandResult>
  readonly now?: () => Date
}

interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
}

function safeRef(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,199}$/.test(value))
    throw new Error(`${label} is not a safe explicit Git ref`)
  if (
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    value.endsWith(".") ||
    value.endsWith(".lock")
  )
    throw new Error(`${label} is not a safe explicit Git ref`)
  return value
}

function privateIPv4(address: string) {
  const octets = address.split(".").map(Number)
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true
  const [a, b, c, d] = octets
  if (a === undefined || b === undefined || c === undefined || d === undefined) return true
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  )
}

export function publicNetworkAddress(address: string) {
  const kind = isIP(address)
  if (kind === 4) return !privateIPv4(address)
  if (kind !== 6) return false
  const normalized = address.toLowerCase()
  if (normalized.startsWith("::ffff:")) return publicNetworkAddress(normalized.slice(7))
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  )
}

export function parseSourceImportRequest(value: unknown): SourceImportRequest {
  if (!isRecord(value)) throw new Error("source_import requires an object")
  const input = value
  if (typeof input.url !== "string" || !input.url.trim() || input.url.length > 2_048)
    throw new Error("source_import url must contain 1-2048 characters")
  let url: URL
  try {
    url = new URL(input.url.trim())
  } catch {
    throw new Error("source_import requires a valid HTTPS URL")
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
    throw new Error("source_import accepts credential-free HTTPS URLs on the standard port only")
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!host || host === "localhost" || host.endsWith(".local") || (isIP(host) !== 0 && !publicNetworkAddress(host)))
    throw new Error("source_import requires a public hostname")
  const additional = input.additional_refs
  if (additional !== undefined && (!Array.isArray(additional) || additional.length > MAX_REFS))
    throw new Error(`source_import additional_refs must contain at most ${MAX_REFS} refs`)
  const additionalRefs = additional?.map((item, index) => safeRef(item, `additional_refs[${index}]`)) ?? []
  return {
    url: url.toString(),
    host,
    checkoutRef: input.checkout_ref === undefined ? undefined : safeRef(input.checkout_ref, "checkout_ref"),
    additionalRefs: [...new Set(additionalRefs)],
  }
}

async function readBounded(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return { text: "", truncated: false }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let retained = 0
  let truncated = false
  while (true) {
    const next = await reader.read()
    if (next.done) break
    const remaining = MAX_OUTPUT_BYTES - retained
    if (remaining <= 0) {
      truncated = true
      continue
    }
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

const gitPolicy = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "credential.helper=",
  "-c",
  "http.proxy=",
  "-c",
  "https.proxy=",
  "-c",
  "http.extraHeader=",
  "-c",
  "submodule.recurse=false",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.required=false",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "protocol.ssh.allow=never",
  "-c",
  "protocol.git.allow=never",
  "-c",
  "protocol.http.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "http.followRedirects=false",
] as const

// ── Public Imports Do Not Inherit Ambient Network Authority ────────────────
// A validated URL and DNS pin are insufficient when Git can inherit a proxy,
// injected GIT_CONFIG_* entries, credential helpers, client certificates, or a
// user's netrc. Each command therefore receives a small process environment and
// a fresh empty home. Locale, executable discovery, temporary directories, and
// public CA bundles remain available; network routing and authentication do not.
// ─────────────────────────────────────────────────────────────────────────────

export function sourceImportGitEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  isolatedHome: string,
) {
  const safe = Object.fromEntries(
    Object.entries(inherited).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_[A-Z0-9_]+|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE)$/i.test(
          entry[0],
        ),
    ),
  )
  return {
    ...safe,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: isolatedHome,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) throw new Error("source import manifest contains a non-canonical value")
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .toSorted()
      .map((key) => [key, canonicalValue(value[key])]),
  )
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value))
}

function sourceImportLedgerKey(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const key = environment.CYBERFUL_CODE_GRAPH_LEDGER_KEY?.trim()
  if (!key || Buffer.byteLength(key) < 32) throw new Error("source import attestation is unavailable")
  return key
}

function manifestPayload(manifest: Readonly<Record<string, unknown>>) {
  const { attestation: _attestation, ...payload } = manifest
  return payload
}

function manifestHmac(payload: unknown, key: string) {
  return createHmac("sha256", key).update(canonicalJson(payload)).digest("hex")
}

export function attestSourceImportManifest(
  payload: SourceImportManifestPayload,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SourceImportManifest {
  return {
    ...payload,
    attestation: {
      algorithm: "hmac-sha256",
      hmac_sha256: manifestHmac(payload, sourceImportLedgerKey(environment)),
    },
  }
}

function sameDigest(expectedHex: string, actualHex: string) {
  if (!/^[a-f0-9]{64}$/i.test(expectedHex) || !/^[a-f0-9]{64}$/i.test(actualHex)) return false
  const expected = Buffer.from(expectedHex, "hex")
  const actual = Buffer.from(actualHex, "hex")
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual)
}

function updateFingerprintField(digest: ReturnType<typeof createHash>, value: string | Buffer) {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value
  const length = Buffer.allocUnsafe(8)
  length.writeBigUInt64BE(BigInt(bytes.byteLength))
  digest.update(length)
  digest.update(bytes)
}

// ── Content Seal Excludes Only Git's Private Database ─────────────────────
// Paths, regular-file contents, executable bits, symlink targets, and empty
// directories all contribute to the digest. The traversal never follows a
// symlink and rejects special filesystem entries, so the result describes the
// exact source tree exposed to later phases rather than Git's mutable metadata.
// ─────────────────────────────────────────────────────────────────────────────

export async function sourceImportTreeFingerprint(root: string): Promise<SourceTreeFingerprint> {
  const rootMetadata = await lstat(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())
    throw new Error("source import repository is not a plain directory")
  const canonicalRoot = await realpath(root)
  const digest = createHash("sha256")
  let entries = 0
  let files = 0
  let bytes = 0

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const children = (await readdir(directory, { withFileTypes: true })).toSorted((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    for (const child of children) {
      if (child.name === ".git") continue
      const absolute = path.join(directory, child.name)
      const relative = prefix ? `${prefix}/${child.name}` : child.name
      const metadata = await lstat(absolute)
      entries++
      updateFingerprintField(digest, relative)
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        updateFingerprintField(digest, "directory")
        await visit(absolute, relative)
        continue
      }
      if (metadata.isSymbolicLink()) {
        updateFingerprintField(digest, "symlink")
        updateFingerprintField(digest, await readlink(absolute))
        continue
      }
      if (!metadata.isFile()) throw new Error(`source import contains an unsupported entry: ${relative}`)
      const handle = await open(absolute, filesystemConstants.O_RDONLY | (filesystemConstants.O_NOFOLLOW ?? 0)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ELOOP") throw new Error(`source import file became a symlink: ${relative}`)
          throw error
        },
      )
      const contentDigest = createHash("sha256")
      try {
        const opened = await handle.stat()
        if (!opened.isFile()) throw new Error(`source import entry changed while it was read: ${relative}`)
        const chunk = Buffer.allocUnsafe(64 * 1024)
        let position = 0
        while (true) {
          const result = await handle.read(chunk, 0, chunk.byteLength, position)
          if (result.bytesRead === 0) break
          contentDigest.update(chunk.subarray(0, result.bytesRead))
          position += result.bytesRead
        }
        const finalOpened = await handle.stat()
        const finalPath = await lstat(absolute)
        if (
          !finalPath.isFile() ||
          finalPath.isSymbolicLink() ||
          finalOpened.size !== position ||
          finalPath.size !== position ||
          finalOpened.dev !== finalPath.dev ||
          finalOpened.ino !== finalPath.ino
        )
          throw new Error(`source import file changed while it was read: ${relative}`)
        updateFingerprintField(digest, "file")
        updateFingerprintField(digest, finalOpened.mode & 0o111 ? "executable" : "regular")
        updateFingerprintField(digest, contentDigest.digest())
        files++
        bytes += position
      } finally {
        await handle.close()
      }
    }
  }

  await visit(canonicalRoot, "")
  return {
    algorithm: "sha256",
    sha256: digest.digest("hex"),
    entries,
    files,
    bytes,
    excludes: [".git"],
  }
}

async function defaultRunGit(args: readonly string[], cwd: string): Promise<CommandResult> {
  const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "cyberful-public-git-"))
  const child = Bun.spawn(["git", ...gitPolicy, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: sourceImportGitEnvironment(process.env, isolatedHome),
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), IMPORT_TIMEOUT_MS)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBounded(child.stdout),
      readBounded(child.stderr),
    ])
    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
    }
  } finally {
    clearTimeout(timer)
    await rm(isolatedHome, { recursive: true, force: true })
  }
}

async function verifyOfflineGitIdentity(repository: string, manifest: SourceImportManifest) {
  const gitDirectory = path.join(repository, ".git")
  const gitMetadata = await lstat(gitDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!gitMetadata?.isDirectory() || gitMetadata.isSymbolicLink())
    throw new Error("source import Git metadata is missing or unsafe")

  const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "cyberful-offline-import-git-"))
  const resolveCommit = async (ref: string) => {
    const child = Bun.spawn(
      [
        "git",
        ...gitPolicy,
        "-c",
        "protocol.https.allow=never",
        "-c",
        "remote.origin.promisor=false",
        "rev-parse",
        "--verify",
        `${ref}^{commit}`,
      ],
      {
        cwd: repository,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...sourceImportGitEnvironment(process.env, isolatedHome),
          GIT_ALLOW_PROTOCOL: "",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    )
    const timer = setTimeout(() => child.kill("SIGKILL"), VERIFY_TIMEOUT_MS)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        readBounded(child.stdout),
        readBounded(child.stderr),
      ])
      const result = {
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
      }
      const commit = success(result, `Offline source identity '${ref}'`).trim()
      if (!COMMIT_PATTERN.test(commit)) throw new Error(`source import '${ref}' resolved an invalid commit id`)
      return commit.toLowerCase()
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    if ((await resolveCommit("HEAD")) !== manifest.commit.toLowerCase())
      throw new Error("source import HEAD no longer matches its attested commit")
    for (const ref of manifest.sealed_refs) {
      if ((await resolveCommit(ref.local_ref)) !== ref.commit.toLowerCase())
        throw new Error(`source import ref '${ref.local_ref}' no longer matches its attested commit`)
    }
  } finally {
    await rm(isolatedHome, { recursive: true, force: true })
  }
}

function success(result: CommandResult, operation: string) {
  if (result.truncated) throw new Error(`${operation} output exceeded its safety limit`)
  if (result.exitCode !== 0) throw new Error(`${operation} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  return result.stdout.trim()
}

// ── Authentication Precedes Complete Runtime Reconstruction ─────
// The HMAC is checked against the received JSON before normalization, so no
// field can change without invalidating the seal. Authentication alone does not
// make field shapes trustworthy: every value is narrowed, bounded, and related
// to the canonical URL/ref request before a fresh manifest object is returned.
// Reconstructing the result prevents unvalidated fields from crossing inward.
// ─────────────────────────────────────────────────────────────────
function parseAttestedManifest(value: unknown, key: string): SourceImportManifest {
  if (!isRecord(value)) throw new Error("source import manifest is malformed")
  const attestation = value.attestation
  if (!isRecord(attestation) || attestation.algorithm !== "hmac-sha256" || typeof attestation.hmac_sha256 !== "string")
    throw new Error("source import manifest attestation is missing or malformed")
  const expectedHmac = manifestHmac(manifestPayload(value), key)
  if (!sameDigest(expectedHmac, attestation.hmac_sha256))
    throw new Error("source import manifest attestation does not match")

  const tree = value.tree
  const localRefs = value.local_refs
  const sealedRefs = value.sealed_refs
  if (
    value.version !== 2 ||
    typeof value.url !== "string" ||
    typeof value.host !== "string" ||
    !Array.isArray(value.additional_refs) ||
    value.additional_refs.length > MAX_REFS ||
    !isRecord(localRefs) ||
    Object.keys(localRefs).length > MAX_REFS + 1 ||
    !Array.isArray(sealedRefs) ||
    sealedRefs.length > MAX_REFS + 1 ||
    typeof value.commit !== "string" ||
    !COMMIT_PATTERN.test(value.commit) ||
    !isRecord(tree) ||
    tree.algorithm !== "sha256" ||
    typeof tree.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(tree.sha256) ||
    typeof tree.entries !== "number" ||
    !Number.isSafeInteger(tree.entries) ||
    tree.entries < 0 ||
    tree.entries > MAX_IMPORT_FILES ||
    typeof tree.files !== "number" ||
    !Number.isSafeInteger(tree.files) ||
    tree.files < 0 ||
    tree.files > MAX_IMPORT_FILES ||
    typeof tree.bytes !== "number" ||
    !Number.isSafeInteger(tree.bytes) ||
    tree.bytes < 0 ||
    tree.bytes > MAX_IMPORT_BYTES ||
    !Array.isArray(tree.excludes) ||
    tree.excludes.length !== 1 ||
    tree.excludes[0] !== ".git" ||
    !Array.isArray(value.resolved_addresses) ||
    value.resolved_addresses.length === 0 ||
    value.resolved_addresses.some(
      (address) => typeof address !== "string" || isIP(address) === 0 || !publicNetworkAddress(address),
    ) ||
    typeof value.files_on_disk !== "number" ||
    !Number.isSafeInteger(value.files_on_disk) ||
    value.files_on_disk < 0 ||
    value.files_on_disk > MAX_IMPORT_FILES ||
    typeof value.bytes_on_disk !== "number" ||
    !Number.isSafeInteger(value.bytes_on_disk) ||
    value.bytes_on_disk < 0 ||
    value.bytes_on_disk > MAX_IMPORT_BYTES ||
    value.network_complete !== true ||
    typeof value.history_complete !== "boolean" ||
    value.hooks !== false ||
    value.submodules !== false ||
    value.lfs_smudge !== false ||
    value.dependencies !== false ||
    typeof value.created_at !== "string"
  )
    throw new Error("source import manifest is malformed")

  const createdAt = new Date(value.created_at)
  if (!Number.isFinite(createdAt.valueOf()) || createdAt.toISOString() !== value.created_at)
    throw new Error("source import manifest contains an invalid creation time")

  const request = parseSourceImportRequest({
    url: value.url,
    checkout_ref: value.checkout_ref,
    additional_refs: value.additional_refs,
  })
  if (request.url !== value.url || request.host !== value.host)
    throw new Error("source import manifest URL and host do not match")

  const mappedEntries = Object.entries(localRefs)
  if (mappedEntries.some(([, ref]) => typeof ref !== "string" || !SEALED_REF_PATTERN.test(ref)))
    throw new Error("source import manifest contains an invalid local ref mapping")
  const parsedLocalRefs = Object.fromEntries(mappedEntries.map(([name, ref]) => [name, String(ref)]))
  const mappedRefs = Object.values(parsedLocalRefs)
  const parsedRefs: SealedSourceRef[] = []
  for (const item of sealedRefs) {
    if (
      !isRecord(item) ||
      typeof item.requested_ref !== "string" ||
      typeof item.local_ref !== "string" ||
      !SEALED_REF_PATTERN.test(item.local_ref) ||
      typeof item.commit !== "string" ||
      !COMMIT_PATTERN.test(item.commit)
    )
      throw new Error("source import manifest contains an invalid sealed ref")
    safeRef(item.requested_ref, "sealed requested_ref")
    parsedRefs.push({
      requested_ref: item.requested_ref,
      local_ref: item.local_ref,
      commit: item.commit.toLowerCase(),
    })
  }
  const expectedMappings = parsedRefs.map((item) => item.local_ref).toSorted()
  if (
    mappedRefs.length !== expectedMappings.length ||
    mappedRefs.toSorted().some((ref, index) => ref !== expectedMappings[index])
  )
    throw new Error("source import local ref mappings do not match the attested refs")

  const expectedRequestedRefs = [request.checkoutRef, ...request.additionalRefs].filter(
    (ref): ref is string => ref !== undefined,
  )
  if (
    parsedRefs.length !== expectedRequestedRefs.length ||
    parsedRefs.some((ref, index) => ref.requested_ref !== expectedRequestedRefs[index])
  )
    throw new Error("source import sealed refs do not match the requested refs")

  return {
    version: 2,
    url: request.url,
    host: request.host,
    checkout_ref: request.checkoutRef,
    additional_refs: request.additionalRefs,
    local_refs: parsedLocalRefs,
    sealed_refs: parsedRefs,
    commit: value.commit.toLowerCase(),
    tree: {
      algorithm: "sha256",
      sha256: tree.sha256.toLowerCase(),
      entries: tree.entries,
      files: tree.files,
      bytes: tree.bytes,
      excludes: [".git"],
    },
    resolved_addresses: value.resolved_addresses,
    files_on_disk: value.files_on_disk,
    bytes_on_disk: value.bytes_on_disk,
    network_complete: true,
    history_complete: value.history_complete,
    hooks: false,
    submodules: false,
    lfs_smudge: false,
    dependencies: false,
    created_at: value.created_at,
    attestation: {
      algorithm: "hmac-sha256",
      hmac_sha256: attestation.hmac_sha256.toLowerCase(),
    },
  }
}

// Verify the authenticated manifest before trusting any of its fields, then
// independently bind the current checkout to both its filesystem content and
// its offline Git identities. Callers receive no usable root on any mismatch.
export async function verifySourceImport(
  repository: string,
  manifestPath: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const key = sourceImportLedgerKey(environment)
  const metadata = await lstat(manifestPath)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MANIFEST_BYTES)
    throw new Error("source import manifest is missing or unsafe")
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"))
  } catch {
    throw new Error("source import manifest is not valid JSON")
  }
  const manifest = parseAttestedManifest(parsed, key)
  await verifyOfflineGitIdentity(repository, manifest)
  const fingerprint = await sourceImportTreeFingerprint(repository)
  if (canonicalJson(fingerprint) !== canonicalJson(manifest.tree))
    throw new Error("source import tree no longer matches its attested content")
  return manifest
}

function pinnedNetworkArgs(request: SourceImportRequest, addresses: readonly string[], args: readonly string[]) {
  if (isIP(request.host) !== 0) return [...args]
  const destinations = addresses.map((address) => (isIP(address) === 6 ? `[${address}]` : address)).join(",")
  return ["-c", `http.curloptResolve=${request.host}:443:${destinations}`, ...args]
}

async function importSize(root: string) {
  const directories = [root]
  let files = 0
  let bytes = 0
  while (directories.length > 0) {
    const directory = directories.pop()
    if (!directory) break
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) directories.push(target)
      else {
        const metadata = await lstat(target)
        files++
        bytes += metadata.size
      }
      if (files > MAX_IMPORT_FILES || bytes > MAX_IMPORT_BYTES)
        throw new Error("source import exceeds its file or byte limit")
    }
  }
  return { files, bytes }
}

export async function handleSourceImport(args: Record<string, unknown>, hooks: SourceImportHooks) {
  const request = parseSourceImportRequest(args)
  const attestationKey = sourceImportLedgerKey()
  const historyComplete = process.env.CYBERFUL_SUBSYSTEM_WORKFLOW === "secure-review"
  const workarea = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim()
  if (!workarea || !path.isAbsolute(workarea)) throw new Error("source_import requires an absolute workarea")
  const canonicalWorkarea = await realpath(workarea)
  const repository = path.join(canonicalWorkarea, "raw", "source-import", "repository")
  const existing = await lstat(repository).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing) throw new Error("a source import already exists in this workarea")
  if (!(await hooks.confirm(request))) return { imported: false, reason: "human-declined" }
  const addresses = await (
    hooks.resolveHost ?? (async (host) => (await lookup(host, { all: true })).map((item) => item.address))
  )(request.host)
  if (addresses.length === 0 || addresses.some((address) => !publicNetworkAddress(address)))
    throw new Error("source_import hostname does not resolve exclusively to public network addresses")
  const importRoot = await ensureWorkareaDirectory(canonicalWorkarea, "raw/source-import")
  const temporary = path.join(importRoot, `.repository-${randomUUID()}.tmp`)
  const runGit = hooks.runGit ?? defaultRunGit
  const localRefs: Record<string, string> = {}
  const sealedRefs: SealedSourceRef[] = []
  try {
    success(
      await runGit(
        pinnedNetworkArgs(request, addresses, [
          "clone",
          "--no-checkout",
          "--no-tags",
          "--no-recurse-submodules",
          ...(historyComplete ? [] : ["--depth=1"]),
          request.url,
          temporary,
        ]),
        canonicalWorkarea,
      ),
      "Public source clone",
    )
    if (request.checkoutRef) {
      success(
        await runGit(
          pinnedNetworkArgs(request, addresses, [
            "fetch",
            "--no-tags",
            ...(historyComplete ? [] : ["--depth=1"]),
            "origin",
            request.checkoutRef,
          ]),
          temporary,
        ),
        "Checkout ref fetch",
      )
      success(await runGit(["update-ref", "refs/cyberful/import-head", "FETCH_HEAD"], temporary), "Checkout ref seal")
      localRefs.checkout = "refs/cyberful/import-head"
      const refCommit = success(
        await runGit(["rev-parse", "refs/cyberful/import-head^{commit}"], temporary),
        "Checkout ref resolution",
      )
      if (!COMMIT_PATTERN.test(refCommit)) throw new Error("source_import checkout ref resolved an invalid commit id")
      sealedRefs.push({
        requested_ref: request.checkoutRef,
        local_ref: "refs/cyberful/import-head",
        commit: refCommit.toLowerCase(),
      })
    }
    for (const [index, ref] of request.additionalRefs.entries()) {
      success(
        await runGit(
          pinnedNetworkArgs(request, addresses, [
            "fetch",
            "--no-tags",
            ...(historyComplete ? [] : ["--depth=1"]),
            "origin",
            ref,
          ]),
          temporary,
        ),
        `Additional ref '${ref}' fetch`,
      )
      const local = `refs/cyberful/import/${index}`
      success(await runGit(["update-ref", local, "FETCH_HEAD"], temporary), `Additional ref '${ref}' seal`)
      localRefs[ref === "checkout" && localRefs.checkout ? `additional:${ref}` : ref] = local
      const refCommit = success(
        await runGit(["rev-parse", `${local}^{commit}`], temporary),
        `Additional ref '${ref}' resolution`,
      )
      if (!COMMIT_PATTERN.test(refCommit)) throw new Error(`source_import additional ref '${ref}' resolved invalid`)
      sealedRefs.push({ requested_ref: ref, local_ref: local, commit: refCommit.toLowerCase() })
    }
    const checkout = request.checkoutRef ? "refs/cyberful/import-head" : "HEAD"
    success(await runGit(["checkout", "--detach", "--force", checkout], temporary), "Imported source checkout")
    const commit = success(await runGit(["rev-parse", "HEAD^{commit}"], temporary), "Imported commit resolution")
    if (!COMMIT_PATTERN.test(commit)) throw new Error("source_import resolved an invalid commit id")
    const tree = await sourceImportTreeFingerprint(temporary)
    const size = await importSize(temporary)
    await rename(temporary, repository)
    const payload = {
      version: 2 as const,
      url: request.url,
      host: request.host,
      checkout_ref: request.checkoutRef,
      additional_refs: request.additionalRefs,
      local_refs: localRefs,
      sealed_refs: sealedRefs,
      commit: commit.toLowerCase(),
      tree,
      resolved_addresses: addresses,
      files_on_disk: size.files,
      bytes_on_disk: size.bytes,
      network_complete: true as const,
      history_complete: historyComplete,
      hooks: false as const,
      submodules: false as const,
      lfs_smudge: false as const,
      dependencies: false as const,
      created_at: (hooks.now ?? (() => new Date()))().toISOString(),
    }
    const manifest = attestSourceImportManifest(payload, {
      CYBERFUL_CODE_GRAPH_LEDGER_KEY: attestationKey,
    })
    await replaceWorkareaFile(
      canonicalWorkarea,
      "raw/source-import/manifest.json",
      JSON.stringify(manifest, null, 2) + "\n",
      {
        mode: 0o600,
      },
    )
    return {
      imported: true,
      repository: "raw/source-import/repository",
      manifest: "raw/source-import/manifest.json",
      ...manifest,
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
