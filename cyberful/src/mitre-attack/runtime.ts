// ── MITRE ATT&CK Runtime Snapshot Resolution ─────────────────────
// Opens only the build-produced local snapshot selected by bootstrap; runtime
// code never downloads, refreshes, or substitutes ATT&CK knowledge.
// → cyberful/src/bootstrap-mitre-attack.ts — materializes release bytes.
// → cyberful/src/subsystem/mitre-attack/server.ts — reports unavailable state.
// @docs/runtimes/mitre-attack.md
// ─────────────────────────────────────────────────────────────────

import fs from "node:fs"
import path from "node:path"
import type { AttackSnapshotManifest } from "./types"

export const ATTACK_RUNTIME_DIR_ENV = "CYBERFUL_MITRE_ATTACK_DIR"

export interface AttackRuntimeSnapshot {
  readonly directory: string
  readonly databasePath: string
  readonly manifest: AttackSnapshotManifest
}

function isManifest(value: unknown): value is AttackSnapshotManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const manifest = value as Partial<AttackSnapshotManifest>
  return (
    manifest.schema_version === 1 &&
    typeof manifest.snapshot_id === "string" &&
    Array.isArray(manifest.domains) &&
    manifest.domains.length === 3 &&
    typeof manifest.database?.file === "string" &&
    typeof manifest.database?.sha256 === "string"
  )
}

export function readAttackRuntimeSnapshot(directory = process.env[ATTACK_RUNTIME_DIR_ENV]?.trim()): AttackRuntimeSnapshot | undefined {
  if (!directory) return
  const root = path.resolve(directory)
  const manifestPath = path.join(root, "manifest.json")
  if (!fs.statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) return
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  } catch {
    return
  }
  if (!isManifest(value)) return
  if (path.isAbsolute(value.database.file) || value.database.file.split(/[\\/]/u).some((part) => !part || part === "." || part === "..")) {
    return
  }
  const databasePath = path.join(root, value.database.file)
  if (!fs.statSync(databasePath, { throwIfNoEntry: false })?.isFile()) return
  return { directory: root, databasePath, manifest: value }
}
