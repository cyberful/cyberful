// ── Host-Owned Source Store ──────────────────────────────────────
// Places imported source and deterministic snapshots outside the model-writable
// workarea, with one durable import-attestation key per canonical workarea.
// → cyberful/src/session/prompt.ts — publishes the private store capability to gateways.
// → cyberful/src/subsystem/gateway/source-import.ts — owns imported repository content.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { constants } from "node:fs"
import { chmod, link, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises"
import { createHash, randomBytes } from "node:crypto"
import { Global } from "@/global"

const KEY_PATTERN = /^[a-f0-9]{64}$/

function nodeErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

function isContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function ensurePlainChild(root: string, name: string) {
  const candidate = path.join(root, name)
  const existing = await lstat(candidate).catch((error) => {
    if (nodeErrorCode(error) === "ENOENT") return undefined
    throw error
  })
  if (!existing)
    await mkdir(candidate, { mode: 0o700 }).catch((error) => {
      if (nodeErrorCode(error) !== "EEXIST") throw error
    })
  const metadata = await lstat(candidate)
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("source store path contains a non-directory or symlink")
  const canonical = await realpath(candidate)
  if (!isContained(root, canonical)) throw new Error("source store path escapes its host-owned root")
  if (process.platform !== "win32") await chmod(canonical, 0o700)
  return canonical
}

async function readAttestationKey(file: string) {
  const metadata = await lstat(file)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128)
    throw new Error("source import attestation key is missing or unsafe")
  const key = (await readFile(file, "utf8")).trim()
  if (!KEY_PATTERN.test(key)) throw new Error("source import attestation key is malformed")
  if (process.platform !== "win32") await chmod(file, 0o600)
  return key
}

// ── Attestation Keys Become Visible Atomically ────────────────────
// Separate Cyberful processes may open the same canonical workarea at once.
// Writing directly to the final path would expose an empty or partial key to a
// losing creator. Each contender instead syncs a private file, then atomically
// links it into place without replacement. The winner publishes complete bytes;
// every loser reads that same durable key, preserving import verification across
// concurrent starts and later session resumption.
// ─────────────────────────────────────────────────────────────────
async function durableAttestationKey(importRoot: string) {
  const file = path.join(importRoot, "attestation.key")
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
  const key = randomBytes(32).toString("hex")
  try {
    const handle = await open(temporary, flags, 0o600)
    try {
      await handle.writeFile(`${key}\n`, { encoding: "utf8" })
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(temporary, file)
      return key
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") throw error
      return await readAttestationKey(file)
    }
  } catch (error) {
    if (nodeErrorCode(error) === "EEXIST") return readAttestationKey(file)
    throw error
  } finally {
    await rm(temporary, { force: true })
  }
}

export interface SourceStore {
  readonly root: string
  readonly importRoot: string
  readonly attestationKey: string
}

export async function ensureSourceStore(workareaRoot: string, dataRoot = Global.Path.data): Promise<SourceStore> {
  if (!path.isAbsolute(workareaRoot) || !path.isAbsolute(dataRoot))
    throw new Error("source store requires absolute workarea and data roots")
  const [workarea, data] = await Promise.all([realpath(workareaRoot), realpath(dataRoot)])
  const dataMetadata = await lstat(data)
  if (!dataMetadata.isDirectory() || dataMetadata.isSymbolicLink())
    throw new Error("source store data root must be a plain directory")
  const stores = await ensurePlainChild(data, "source-store")
  const identity = createHash("sha256").update(workarea).digest("hex")
  const root = await ensurePlainChild(stores, identity)
  if (isContained(workarea, root) || isContained(root, workarea))
    throw new Error("source store must be physically separate from the model workarea")
  const importRoot = await ensurePlainChild(root, "import")
  return { root, importRoot, attestationKey: await durableAttestationKey(importRoot) }
}

export * as HostSourceStore from "./source-store"
