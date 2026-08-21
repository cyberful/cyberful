// ── MITRE ATT&CK Snapshot Contracts ──────────────────────────────
// Defines the build-produced manifest and the bounded records shared by the
// snapshot builder, embedded runtime, local store, and MCP server.
// → cyberful/script/build.ts — embeds one completed snapshot in every binary.
// → cyberful/src/subsystem/mitre-attack/server.ts — publishes these records.
// @docs/runtimes/mitre-attack.md
// ─────────────────────────────────────────────────────────────────

export const ATTACK_DOMAINS = ["enterprise", "mobile", "ics"] as const
export type AttackDomain = (typeof ATTACK_DOMAINS)[number]

export const ATTACK_OBJECT_TYPES = ["tactic", "technique", "software", "group"] as const
export type AttackObjectType = (typeof ATTACK_OBJECT_TYPES)[number]

export interface AttackSnapshotDomain {
  readonly domain: AttackDomain
  readonly collection_id: string
  readonly collection_name: string
  readonly version: string
  readonly modified: string
  readonly url: string
  readonly source_file: string
  readonly sha256: string
  readonly bytes: number
  readonly objects: number
  readonly relationships: number
}

export interface AttackSnapshotManifest {
  readonly schema_version: 1
  readonly snapshot_id: string
  readonly generated_at: string
  readonly cyberful: {
    readonly version: string
    readonly build_id: string
  }
  readonly index: {
    readonly url: string
    readonly modified: string
    readonly sha256: string
    readonly bytes: number
    readonly source_file: string
  }
  readonly domains: readonly AttackSnapshotDomain[]
  readonly database: {
    readonly schema_version: 1
    readonly file: string
    readonly sha256: string
    readonly bytes: number
    readonly gzip_file: string
    readonly gzip_sha256: string
    readonly gzip_bytes: number
  }
  readonly license: {
    readonly url: string
    readonly file: string
    readonly sha256: string
    readonly bytes: number
  }
}

export interface EmbeddedAttackSnapshot {
  readonly manifest: AttackSnapshotManifest
  readonly database_gzip_base64: string
  readonly license: string
}

export interface AttackObjectRecord {
  readonly snapshot_id: string
  readonly stix_id: string
  readonly attack_id?: string
  readonly domain: AttackDomain
  readonly object_type: AttackObjectType
  readonly stix_type: string
  readonly name: string
  readonly description: string
  readonly description_truncated: boolean
  readonly aliases: readonly string[]
  readonly platforms: readonly string[]
  readonly tactics: readonly string[]
  readonly created?: string
  readonly modified?: string
  readonly revoked: boolean
  readonly deprecated: boolean
  readonly subtechnique: boolean
  readonly url?: string
}

export interface AttackRelationshipRecord {
  readonly snapshot_id: string
  readonly stix_id: string
  readonly domain: AttackDomain
  readonly relationship_type: string
  readonly source_ref: string
  readonly target_ref: string
  readonly description: string
  readonly description_truncated: boolean
  readonly created?: string
  readonly modified?: string
  readonly revoked: boolean
  readonly indirect: boolean
  readonly path?: readonly string[]
}
