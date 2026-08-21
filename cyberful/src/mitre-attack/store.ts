// ── Read-Only MITRE ATT&CK Query Store ───────────────────────────
// Provides deterministic bounded lookup, search, relationship traversal, and
// matrix views over the build-generated SQLite snapshot.
// → cyberful/src/mitre-attack/builder.ts — creates the database schema.
// → cyberful/src/subsystem/mitre-attack/server.ts — validates MCP requests.
// @docs/runtimes/mitre-attack.md
// ─────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import fs from "node:fs"
import { Database } from "bun:sqlite"
import {
  ATTACK_DOMAINS,
  ATTACK_OBJECT_TYPES,
  type AttackDomain,
  type AttackObjectRecord,
  type AttackObjectType,
  type AttackRelationshipRecord,
  type AttackSnapshotManifest,
} from "./types"

interface ObjectRow {
  readonly domain: string
  readonly stix_id: string
  readonly attack_id: string | null
  readonly object_type: string
  readonly stix_type: string
  readonly name: string
  readonly description: string
  readonly aliases_json: string
  readonly platforms_json: string
  readonly tactics_json: string
  readonly created: string | null
  readonly modified: string | null
  readonly revoked: number
  readonly deprecated: number
  readonly subtechnique: number
  readonly url: string | null
}

interface RelationshipRow {
  readonly domain: string
  readonly stix_id: string
  readonly relationship_type: string
  readonly source_ref: string
  readonly target_ref: string
  readonly description: string
  readonly created: string | null
  readonly modified: string | null
  readonly revoked: number
}

export interface AttackSearchInput {
  readonly query: string
  readonly domains?: readonly AttackDomain[]
  readonly objectTypes?: readonly AttackObjectType[]
  readonly tactics?: readonly string[]
  readonly platforms?: readonly string[]
  readonly includeRevoked?: boolean
  readonly includeDeprecated?: boolean
  readonly limit?: number
  readonly cursor?: string
}

export interface AttackSearchPage {
  readonly items: readonly AttackObjectRecord[]
  readonly next_cursor?: string
}

function parseArray(value: string) {
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : []
}

const DESCRIPTION_LIMIT = 16_000

function boundedDescription(value: string) {
  return {
    description: value.slice(0, DESCRIPTION_LIMIT),
    description_truncated: value.length > DESCRIPTION_LIMIT,
  }
}

function objectRecord(row: ObjectRow, snapshotID: string): AttackObjectRecord {
  return {
    snapshot_id: snapshotID,
    stix_id: row.stix_id,
    ...(row.attack_id ? { attack_id: row.attack_id } : {}),
    domain: row.domain as AttackDomain,
    object_type: row.object_type as AttackObjectType,
    stix_type: row.stix_type,
    name: row.name,
    ...boundedDescription(row.description),
    aliases: parseArray(row.aliases_json),
    platforms: parseArray(row.platforms_json),
    tactics: parseArray(row.tactics_json),
    ...(row.created ? { created: row.created } : {}),
    ...(row.modified ? { modified: row.modified } : {}),
    revoked: row.revoked === 1,
    deprecated: row.deprecated === 1,
    subtechnique: row.subtechnique === 1,
    ...(row.url ? { url: row.url } : {}),
  }
}

function relationshipRecord(row: RelationshipRow, snapshotID: string): AttackRelationshipRecord {
  return {
    snapshot_id: snapshotID,
    stix_id: row.stix_id,
    domain: row.domain as AttackDomain,
    relationship_type: row.relationship_type,
    source_ref: row.source_ref,
    target_ref: row.target_ref,
    ...boundedDescription(row.description),
    ...(row.created ? { created: row.created } : {}),
    ...(row.modified ? { modified: row.modified } : {}),
    revoked: row.revoked === 1,
    indirect: false,
  }
}

function boundedUnique<T extends string>(
  values: readonly T[] | undefined,
  allowed: readonly T[],
  label: string,
  maximumItems = allowed.length,
) {
  if (!values) return []
  if (values.length > maximumItems || values.some((value) => !allowed.includes(value)))
    throw new Error(`${label} is invalid`)
  return [...new Set(values)]
}

function boundedTextFilters(values: readonly string[] | undefined, label: string, maximumItems = 20) {
  if (!values) return []
  const normalized = values.map((value) => value.trim())
  if (normalized.length > maximumItems || normalized.some((value) => !value || value.length > 100)) {
    throw new Error(`${label} is invalid`)
  }
  return [...new Set(normalized)]
}

function cursorSignature(input: Omit<AttackSearchInput, "cursor">) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16)
}

function decodeCursor(value: string | undefined, signature: string) {
  if (!value) return 0
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      offset?: unknown
      signature?: unknown
    }
    if (!Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0 || parsed.signature !== signature)
      throw new Error()
    return Number(parsed.offset)
  } catch {
    throw new Error("MITRE ATT&CK cursor is invalid for this query")
  }
}

function encodeCursor(offset: number, signature: string) {
  return Buffer.from(JSON.stringify({ offset, signature })).toString("base64url")
}

function ftsQuery(value: string) {
  const tokens =
    value
      .normalize("NFKC")
      .match(/[\p{L}\p{N}_.:-]+/gu)
      ?.slice(0, 20) ?? []
  if (tokens.length === 0) throw new Error("MITRE ATT&CK search query contains no searchable tokens")
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ")
}

export class AttackStore {
  readonly #database: Database
  readonly manifest: AttackSnapshotManifest

  constructor(databasePath: string, manifest: AttackSnapshotManifest) {
    const databaseBytes = fs.readFileSync(databasePath)
    if (
      databaseBytes.byteLength !== manifest.database.bytes ||
      createHash("sha256").update(databaseBytes).digest("hex") !== manifest.database.sha256
    ) {
      throw new Error("MITRE ATT&CK database does not match the release manifest")
    }
    this.#database = new Database(databasePath, { readonly: true, strict: true })
    this.manifest = manifest
    this.#database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;")
    const schema = this.#database.query("SELECT value FROM metadata WHERE key = 'schema_version'").get() as {
      value?: unknown
    } | null
    if (schema?.value !== "1") {
      this.#database.close()
      throw new Error("MITRE ATT&CK database schema is unsupported")
    }
  }

  close() {
    this.#database.close()
  }

  search(input: AttackSearchInput): AttackSearchPage {
    const query = input.query.trim()
    if (!query || query.length > 256) throw new Error("MITRE ATT&CK search query must contain 1 to 256 characters")
    const domains = boundedUnique(input.domains, ATTACK_DOMAINS, "MITRE ATT&CK domains")
    const objectTypes = boundedUnique(input.objectTypes, ATTACK_OBJECT_TYPES, "MITRE ATT&CK object types")
    const tactics = boundedTextFilters(input.tactics, "MITRE ATT&CK tactics")
    const platforms = boundedTextFilters(input.platforms, "MITRE ATT&CK platforms")
    const limit = input.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("MITRE ATT&CK search limit must be 1 to 100")
    const canonical = {
      query,
      domains,
      objectTypes,
      tactics,
      platforms,
      includeRevoked: input.includeRevoked === true,
      includeDeprecated: input.includeDeprecated === true,
      limit,
    }
    const signature = cursorSignature(canonical)
    const offset = decodeCursor(input.cursor, signature)
    const clauses = ["object_fts MATCH ?"]
    const parameters: Array<string | number> = [ftsQuery(query)]
    if (!canonical.includeRevoked) clauses.push("o.revoked = 0")
    if (!canonical.includeDeprecated) clauses.push("o.deprecated = 0")
    if (domains.length) {
      clauses.push(`o.domain IN (${domains.map(() => "?").join(", ")})`)
      parameters.push(...domains)
    }
    if (objectTypes.length) {
      clauses.push(`o.object_type IN (${objectTypes.map(() => "?").join(", ")})`)
      parameters.push(...objectTypes)
    }
    for (const tactic of tactics) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(o.tactics_json) WHERE value = ?)")
      parameters.push(tactic)
    }
    for (const platform of platforms) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(o.platforms_json) WHERE value = ?)")
      parameters.push(platform)
    }
    parameters.push(query, query, limit + 1, offset)
    const rows = this.#database
      .query(
        `
      SELECT o.* FROM object_fts
      JOIN object o ON o.id = object_fts.rowid
      WHERE ${clauses.join(" AND ")}
      ORDER BY CASE WHEN o.attack_id = ? THEN 0 WHEN lower(o.name) = lower(?) THEN 1 ELSE 2 END,
        bm25(object_fts), o.name, o.domain, o.stix_id
      LIMIT ? OFFSET ?
    `,
      )
      .all(...parameters) as ObjectRow[]
    const hasNext = rows.length > limit
    return {
      items: rows.slice(0, limit).map((row) => objectRecord(row, this.manifest.snapshot_id)),
      ...(hasNext ? { next_cursor: encodeCursor(offset + limit, signature) } : {}),
    }
  }

  get(identifiers: readonly string[], domains?: readonly AttackDomain[]) {
    const ids = [...new Set(identifiers.map((item) => item.trim()).filter(Boolean))]
    if (ids.length === 0 || ids.length > 20 || ids.some((item) => item.length > 300)) {
      throw new Error("MITRE ATT&CK get requires 1 to 20 bounded identifiers")
    }
    const selectedDomains = boundedUnique(domains, ATTACK_DOMAINS, "MITRE ATT&CK domains")
    const clauses = [
      `(stix_id IN (${ids.map(() => "?").join(", ")}) OR attack_id IN (${ids.map(() => "?").join(", ")}))`,
    ]
    const parameters: string[] = [...ids, ...ids]
    if (selectedDomains.length) {
      clauses.push(`domain IN (${selectedDomains.map(() => "?").join(", ")})`)
      parameters.push(...selectedDomains)
    }
    return (
      this.#database
        .query(`SELECT * FROM object WHERE ${clauses.join(" AND ")} ORDER BY name, domain, stix_id`)
        .all(...parameters) as ObjectRow[]
    ).map((row) => objectRecord(row, this.manifest.snapshot_id))
  }

  relationships(input: {
    readonly identifiers: readonly string[]
    readonly domains?: readonly AttackDomain[]
    readonly direction?: "incoming" | "outgoing" | "both"
    readonly relationshipTypes?: readonly string[]
    readonly includeIndirect?: boolean
    readonly includeRevoked?: boolean
    readonly limit?: number
  }) {
    const selectedDomains = boundedUnique(input.domains, ATTACK_DOMAINS, "MITRE ATT&CK domains")
    const objects = this.get(input.identifiers, selectedDomains)
    if (objects.length === 0) return { objects: [], endpoints: [], endpoints_truncated: false, relationships: [] }
    const direction = input.direction ?? "both"
    if (direction !== "incoming" && direction !== "outgoing" && direction !== "both") {
      throw new Error("MITRE ATT&CK relationship direction is invalid")
    }
    const relationshipTypes = boundedTextFilters(input.relationshipTypes, "MITRE ATT&CK relationship types")
    const limit = input.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error("MITRE ATT&CK relationship limit must be 1 to 500")
    const refs = [...new Set(objects.map((item) => item.stix_id))]
    const directRelationshipTypes = relationshipTypes.filter((value) => value !== "uses-via-software")
    const includeDirect = relationshipTypes.length === 0 || directRelationshipTypes.length > 0
    let direct: AttackRelationshipRecord[] = []
    if (includeDirect) {
      const directionClauses: string[] = []
      const parameters: Array<string | number> = []
      if (direction === "incoming" || direction === "both") {
        directionClauses.push(`target_ref IN (${refs.map(() => "?").join(", ")})`)
        parameters.push(...refs)
      }
      if (direction === "outgoing" || direction === "both") {
        directionClauses.push(`source_ref IN (${refs.map(() => "?").join(", ")})`)
        parameters.push(...refs)
      }
      const clauses = [`(${directionClauses.join(" OR ")})`]
      if (selectedDomains.length) {
        clauses.push(`domain IN (${selectedDomains.map(() => "?").join(", ")})`)
        parameters.push(...selectedDomains)
      }
      if (!input.includeRevoked) clauses.push("revoked = 0")
      if (directRelationshipTypes.length) {
        clauses.push(`relationship_type IN (${directRelationshipTypes.map(() => "?").join(", ")})`)
        parameters.push(...directRelationshipTypes)
      }
      parameters.push(limit)
      direct = (
        this.#database
          .query(
            `SELECT * FROM relationship WHERE ${clauses.join(" AND ")} ORDER BY domain, relationship_type, stix_id LIMIT ?`,
          )
          .all(...parameters) as RelationshipRow[]
      ).map((row) => relationshipRecord(row, this.manifest.snapshot_id))
    }
    const indirect: AttackRelationshipRecord[] = []
    const includeIndirect =
      input.includeIndirect === true &&
      direction !== "incoming" &&
      (relationshipTypes.length === 0 || relationshipTypes.includes("uses-via-software"))
    if (includeIndirect) {
      for (const object of objects.filter((item) => item.object_type === "group")) {
        const rows = this.#database
          .query(
            `
          SELECT r1.domain, r1.stix_id AS first_id, r2.stix_id AS second_id,
            r1.source_ref, r1.target_ref AS middle_ref, r2.target_ref,
            trim(r1.description || '\n' || r2.description) AS description
          FROM relationship r1
          JOIN relationship r2 ON r2.domain = r1.domain AND r2.source_ref = r1.target_ref
          JOIN object middle ON middle.domain = r1.domain AND middle.stix_id = r1.target_ref AND middle.object_type = 'software'
          JOIN object target ON target.domain = r2.domain AND target.stix_id = r2.target_ref AND target.object_type = 'technique'
          WHERE r1.domain = ? AND r1.source_ref = ? AND r1.relationship_type = 'uses' AND r2.relationship_type = 'uses'
            AND r1.revoked = 0 AND r2.revoked = 0
          ORDER BY r1.target_ref, r2.target_ref LIMIT ?
        `,
          )
          .all(object.domain, object.stix_id, limit - indirect.length) as Array<{
          domain: string
          first_id: string
          second_id: string
          source_ref: string
          middle_ref: string
          target_ref: string
          description: string
        }>
        for (const row of rows) {
          indirect.push({
            snapshot_id: this.manifest.snapshot_id,
            stix_id: `indirect:${row.first_id}:${row.second_id}`,
            domain: row.domain as AttackDomain,
            relationship_type: "uses-via-software",
            source_ref: row.source_ref,
            target_ref: row.target_ref,
            ...boundedDescription(row.description),
            revoked: false,
            indirect: true,
            path: [row.source_ref, row.middle_ref, row.target_ref],
          })
          if (indirect.length >= limit) break
        }
        if (indirect.length >= limit) break
      }
    }
    const relationships = [...direct, ...indirect].slice(0, limit)
    const endpointPairs = [
      ...new Map(
        relationships.flatMap((relationship) => {
          const references = relationship.path ?? [relationship.source_ref, relationship.target_ref]
          return references.map(
            (reference) =>
              [`${relationship.domain}\u0000${reference}`, { domain: relationship.domain, reference }] as const,
          )
        }),
      ).values(),
    ]
    const selectedEndpointPairs = endpointPairs.slice(0, 20)
    const selectedEndpointKeys = new Set(selectedEndpointPairs.map((item) => `${item.domain}\u0000${item.reference}`))
    const endpointIDs = [...new Set(selectedEndpointPairs.map((item) => item.reference))]
    const endpointDomains = [...new Set(selectedEndpointPairs.map((item) => item.domain))]
    const endpoints = endpointIDs.length
      ? this.get(endpointIDs, endpointDomains).filter((item) =>
          selectedEndpointKeys.has(`${item.domain}\u0000${item.stix_id}`),
        )
      : []
    return {
      objects,
      endpoints,
      endpoints_truncated: endpointPairs.length > selectedEndpointPairs.length,
      relationships,
    }
  }

  matrix(input: {
    readonly domain: AttackDomain
    readonly platform?: string
    readonly tactics?: readonly string[]
    readonly includeRevoked?: boolean
    readonly includeDeprecated?: boolean
    readonly limit?: number
  }) {
    if (!ATTACK_DOMAINS.includes(input.domain)) throw new Error("MITRE ATT&CK matrix domain is invalid")
    const platform = input.platform?.trim()
    if (input.platform !== undefined && (!platform || platform.length > 100)) {
      throw new Error("MITRE ATT&CK matrix platform is invalid")
    }
    const selectedTactics = boundedTextFilters(input.tactics, "MITRE ATT&CK matrix tactics")
    const limit = input.limit ?? 5
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new Error("MITRE ATT&CK matrix limit must be 1 to 50")
    const matrices = this.#database
      .query("SELECT * FROM matrix WHERE domain = ? ORDER BY name, stix_id LIMIT 10")
      .all(input.domain) as Array<{
      domain: string
      stix_id: string
      name: string
      tactic_refs_json: string
    }>
    return matrices.map((matrix) => {
      const tacticRefs = parseArray(matrix.tactic_refs_json)
      const tactics = tacticRefs
        .flatMap((reference) => this.get([reference], [input.domain]))
        .filter(
          (tactic) =>
            selectedTactics.length === 0 ||
            selectedTactics.includes(tactic.attack_id ?? "") ||
            selectedTactics.includes(tactic.stix_id) ||
            tactic.tactics.some((shortName) => selectedTactics.includes(shortName)),
        )
      return {
        snapshot_id: this.manifest.snapshot_id,
        stix_id: matrix.stix_id,
        name: matrix.name,
        domain: input.domain,
        tactics: tactics.map((tactic) => {
          const clauses = [
            "domain = ?",
            "object_type = 'technique'",
            "EXISTS (SELECT 1 FROM json_each(tactics_json) WHERE value = ?)",
          ]
          const parameters: Array<string | number> = [input.domain, tactic.tactics[0] ?? ""]
          if (!input.includeRevoked) clauses.push("revoked = 0")
          if (!input.includeDeprecated) clauses.push("deprecated = 0")
          if (platform) {
            clauses.push("EXISTS (SELECT 1 FROM json_each(platforms_json) WHERE value = ?)")
            parameters.push(platform)
          }
          const total = this.#database
            .query(`SELECT count(*) AS count FROM object WHERE ${clauses.join(" AND ")}`)
            .get(...parameters) as { count: number }
          const techniques = this.#database
            .query(`SELECT * FROM object WHERE ${clauses.join(" AND ")} ORDER BY attack_id, name LIMIT ?`)
            .all(...parameters, limit) as ObjectRow[]
          return {
            tactic,
            total_techniques: total.count,
            truncated: total.count > techniques.length,
            techniques: techniques.map((row) => objectRecord(row, this.manifest.snapshot_id)),
          }
        }),
      }
    })
  }
}
