// ── Host-Owned Ghidra Project Store ──────────────────────────────
// Places persistent Ghidra projects and journals outside the model-writable
// workarea, keyed by its canonical path so later runtime instances reopen them.
// → cyberful/src/session/prompt.ts — starts an engagement runtime against this store.
// @docs/runtimes/ghidra.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { chmod, lstat, mkdir, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { Global } from "@/global"
import { nodeErrorCode } from "@/util/error"
import { contains as isContained } from "@/util/filesystem"

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
    throw new Error("Ghidra store path contains a non-directory or symlink")
  const canonical = await realpath(candidate)
  if (!isContained(root, canonical)) throw new Error("Ghidra store path escapes its host-owned root")
  if (process.platform !== "win32") await chmod(canonical, 0o700)
  return canonical
}

export interface GhidraStore {
  readonly root: string
  readonly projectRoot: string
}

// ── Persistent Projects Never Enter The Model Workarea ──────────
// A Ghidra project contains mutable databases, user-defined names, comments,
// bookmarks, and job history that must outlive every disposable phase owner and bridge.
// Its identity derives from the canonical workarea, but its physical root is a
// protected application-data directory. Checking both containment directions
// prevents a misconfigured data root from silently placing authoritative state
// below the model's writable tree or wrapping that tree itself.
// ─────────────────────────────────────────────────────────────────
export async function ensureGhidraStore(workareaRoot: string, dataRoot = Global.Path.data): Promise<GhidraStore> {
  if (!path.isAbsolute(workareaRoot) || !path.isAbsolute(dataRoot))
    throw new Error("Ghidra store requires absolute workarea and data roots")
  const [workarea, data] = await Promise.all([realpath(workareaRoot), realpath(dataRoot)])
  const dataMetadata = await lstat(data)
  if (!dataMetadata.isDirectory() || dataMetadata.isSymbolicLink())
    throw new Error("Ghidra store data root must be a plain directory")
  const stores = await ensurePlainChild(data, "ghidra-store")
  const identity = createHash("sha256").update(workarea).digest("hex")
  const root = await ensurePlainChild(stores, identity)
  if (isContained(workarea, root) || isContained(root, workarea))
    throw new Error("Ghidra store must be physically separate from the model workarea")
  return { root, projectRoot: await ensurePlainChild(root, "project") }
}

export * as HostGhidraStore from "./ghidra-store"
