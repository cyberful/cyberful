// ── Embedded MITRE ATT&CK Snapshot Bootstrap ─────────────────────
// Restores the release-bundled read-only SQLite snapshot into a digest-owned
// cache and exposes it to the phase-local MCP without any runtime network path.
// → cyberful/script/build.ts — injects the compressed database and manifest.
// → cyberful/src/mitre-attack/runtime.ts — resolves the selected local snapshot.
// @docs/runtimes/mitre-attack.md
// ─────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { Global } from "@/global"
import { ATTACK_RUNTIME_DIR_ENV } from "@/mitre-attack/runtime"
import type { EmbeddedAttackSnapshot } from "@/mitre-attack/types"

declare const CYBERFUL_EMBEDDED_MITRE_ATTACK: EmbeddedAttackSnapshot | undefined

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex")
}

function safeRelative(value: string) {
  if (path.isAbsolute(value) || value.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe embedded MITRE ATT&CK path: ${JSON.stringify(value)}`)
  }
  return value
}

function validMaterialization(root: string, embedded: EmbeddedAttackSnapshot) {
  const manifestFile = path.join(root, "manifest.json")
  const databaseFile = path.join(root, safeRelative(embedded.manifest.database.file))
  const licenseFile = path.join(root, safeRelative(embedded.manifest.license.file))
  if (!fs.statSync(manifestFile, { throwIfNoEntry: false })?.isFile()) return false
  if (!fs.statSync(databaseFile, { throwIfNoEntry: false })?.isFile()) return false
  if (!fs.statSync(licenseFile, { throwIfNoEntry: false })?.isFile()) return false
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { snapshot_id?: string }
    return (
      manifest.snapshot_id === embedded.manifest.snapshot_id &&
      sha256(fs.readFileSync(databaseFile)) === embedded.manifest.database.sha256 &&
      sha256(fs.readFileSync(licenseFile)) === embedded.manifest.license.sha256
    )
  } catch {
    return false
  }
}

export function materializeEmbeddedSnapshot(embedded: EmbeddedAttackSnapshot, cacheRoot = Global.Path.cache) {
  if (!/^[A-Za-z0-9._-]{1,240}$/.test(embedded.manifest.snapshot_id)) {
    throw new Error("embedded MITRE ATT&CK snapshot id is invalid")
  }
  const root = path.join(cacheRoot, `mitre-attack-${embedded.manifest.snapshot_id}`)
  if (validMaterialization(root, embedded)) return root
  const compressed = Buffer.from(embedded.database_gzip_base64, "base64")
  if (sha256(compressed) !== embedded.manifest.database.gzip_sha256) {
    throw new Error("embedded MITRE ATT&CK compressed database failed integrity verification")
  }
  const database = gunzipSync(compressed, { maxOutputLength: embedded.manifest.database.bytes })
  if (
    database.byteLength !== embedded.manifest.database.bytes ||
    sha256(database) !== embedded.manifest.database.sha256
  ) {
    throw new Error("embedded MITRE ATT&CK database failed integrity verification")
  }
  if (sha256(embedded.license) !== embedded.manifest.license.sha256) {
    throw new Error("embedded MITRE ATT&CK license failed integrity verification")
  }
  const temporary = `${root}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.rmSync(temporary, { recursive: true, force: true })
  fs.mkdirSync(temporary, { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(path.join(temporary, safeRelative(embedded.manifest.database.file)), database, { mode: 0o600 })
    fs.writeFileSync(path.join(temporary, safeRelative(embedded.manifest.license.file)), embedded.license, { mode: 0o600 })
    fs.writeFileSync(path.join(temporary, "manifest.json"), `${JSON.stringify(embedded.manifest, null, 2)}\n`, { mode: 0o600 })
    fs.writeFileSync(path.join(temporary, ".materialized"), embedded.manifest.database.sha256, { mode: 0o600 })
    fs.rmSync(root, { recursive: true, force: true })
    try {
      fs.renameSync(temporary, root)
    } catch (error) {
      if (!validMaterialization(root, embedded)) throw error
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    throw error
  }
  if (!validMaterialization(root, embedded)) throw new Error("MITRE ATT&CK snapshot materialization did not verify")
  return root
}

function activateSourceSnapshot() {
  if (process.env[ATTACK_RUNTIME_DIR_ENV]) return true
  const source = path.resolve(import.meta.dir, "../dist/mitre-attack")
  if (!fs.statSync(path.join(source, "manifest.json"), { throwIfNoEntry: false })?.isFile()) return false
  process.env[ATTACK_RUNTIME_DIR_ENV] = source
  return true
}

function activateSnapshot() {
  if (process.env[ATTACK_RUNTIME_DIR_ENV]) return true
  const embedded = typeof CYBERFUL_EMBEDDED_MITRE_ATTACK === "undefined" ? undefined : CYBERFUL_EMBEDDED_MITRE_ATTACK
  if (!embedded) return activateSourceSnapshot()
  process.env[ATTACK_RUNTIME_DIR_ENV] = materializeEmbeddedSnapshot(embedded)
  return true
}

export const bootstrapMitreAttackReady = activateSnapshot()
