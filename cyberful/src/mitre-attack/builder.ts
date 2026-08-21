// ── MITRE ATT&CK Build-Time Snapshot Builder ─────────────────────
// Resolves the latest official STIX 2.1 collections once, validates bounded
// source bytes, and emits a deterministic SQLite/FTS knowledge snapshot.
// → cyberful/script/build.ts — calls this before compiling release targets.
// → cyberful/src/mitre-attack/store.ts — opens the generated database read-only.
// @docs/runtimes/mitre-attack.md
// ─────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { Database } from "bun:sqlite"
import { ATTACK_DOMAINS, type AttackDomain, type AttackObjectType, type AttackSnapshotDomain, type AttackSnapshotManifest } from "./types"

export const ATTACK_INDEX_URL = "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/index.json"
export const ATTACK_LICENSE_URL = "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/LICENSE.txt"
const OFFICIAL_HOST = "raw.githubusercontent.com"
const OFFICIAL_PREFIX = "/mitre-attack/attack-stix-data/"
const INDEX_LIMIT = 4 * 1024 * 1024
const BUNDLE_LIMIT = 256 * 1024 * 1024
const LICENSE_LIMIT = 128 * 1024
const FETCH_TIMEOUT_MS = 120_000

interface IndexVersion {
  readonly version: string
  readonly url: string
  readonly modified: string
}

interface IndexCollection {
  readonly id: string
  readonly name: string
  readonly versions: readonly IndexVersion[]
}

interface ResolvedDomain {
  readonly domain: AttackDomain
  readonly collection: IndexCollection
  readonly version: IndexVersion
}

export interface SnapshotFetch {
  (url: string, maximumBytes: number): Promise<Buffer>
}

export interface BuildAttackSnapshotOptions {
  readonly outputDir: string
  readonly cyberfulVersion: string
  readonly buildID: string
  readonly now?: () => Date
  readonly fetchBytes?: SnapshotFetch
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maximum = 4_000_000) {
  if (typeof value !== "string" || !value || value.length > maximum) throw new Error(`${label} is invalid`)
  return value
}

function optionalText(value: unknown, maximum = 4_000_000) {
  if (value === undefined) return undefined
  return text(value, "optional STIX text", maximum)
}

function stringArray(value: unknown, maximumItems = 1_000) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error("STIX string array is invalid")
  return [...new Set(value.map((item) => text(item, "STIX string", 10_000)))].sort((left, right) => left.localeCompare(right))
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex")
}

function officialUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.hostname !== OFFICIAL_HOST || !url.pathname.startsWith(OFFICIAL_PREFIX)) {
    throw new Error(`MITRE ATT&CK source URL is not allowlisted: ${value}`)
  }
  if (url.username || url.password || url.port || url.search || url.hash) {
    throw new Error(`MITRE ATT&CK source URL contains unsupported components: ${value}`)
  }
  return url
}

export const fetchOfficialAttackBytes: SnapshotFetch = async (source, maximumBytes) => {
  let url = officialUrl(source)
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json,text/plain;q=0.9", "user-agent": "cyberful-build" },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (!location) throw new Error(`MITRE ATT&CK source ${url} redirected without a location`)
      url = officialUrl(new URL(location, url).toString())
      continue
    }
    if (!response.ok || !response.body) throw new Error(`MITRE ATT&CK source ${url} returned HTTP ${response.status}`)
    const declared = Number(response.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > maximumBytes) {
      throw new Error(`MITRE ATT&CK source ${url} exceeds ${maximumBytes} bytes`)
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximumBytes) {
        await reader.cancel()
        throw new Error(`MITRE ATT&CK source ${url} exceeds ${maximumBytes} bytes`)
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  }
  throw new Error(`MITRE ATT&CK source ${url} exceeded the redirect limit`)
}

function parseJson(bytes: Buffer, label: string) {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
}

const COLLECTION_DOMAIN: Readonly<Record<string, AttackDomain>> = {
  "Enterprise ATT&CK": "enterprise",
  "Mobile ATT&CK": "mobile",
  "ICS ATT&CK": "ics",
}

export function resolveAttackIndex(value: unknown): {
  readonly modified: string
  readonly domains: readonly ResolvedDomain[]
} {
  const root = record(value)
  if (!root) throw new Error("MITRE ATT&CK index must be an object")
  const modified = text(root.modified, "MITRE ATT&CK index modified", 100)
  if (!Array.isArray(root.collections)) throw new Error("MITRE ATT&CK index collections are missing")
  const resolved = new Map<AttackDomain, ResolvedDomain>()
  for (const candidate of root.collections) {
    const collection = record(candidate)
    if (!collection) continue
    const name = typeof collection.name === "string" ? collection.name : ""
    const domain = COLLECTION_DOMAIN[name]
    if (!domain) continue
    const id = text(collection.id, `${name} collection id`, 200)
    if (!Array.isArray(collection.versions) || collection.versions.length === 0) {
      throw new Error(`${name} collection has no versions`)
    }
    const latest = record(collection.versions[0])
    if (!latest) throw new Error(`${name} latest version is invalid`)
    const version = text(latest.version, `${name} version`, 40)
    if (!/^\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error(`${name} version is invalid`)
    const url = officialUrl(text(latest.url, `${name} URL`, 2_000)).toString()
    const expected = `/${domain === "enterprise" ? "enterprise" : domain}-attack/${domain === "enterprise" ? "enterprise" : domain}-attack-${version}.json`
    if (!new URL(url).pathname.endsWith(expected)) throw new Error(`${name} URL does not match version ${version}`)
    resolved.set(domain, {
      domain,
      collection: { id, name, versions: [] },
      version: { version, url, modified: text(latest.modified, `${name} modified`, 100) },
    })
  }
  if (resolved.size !== ATTACK_DOMAINS.length) throw new Error("MITRE ATT&CK index does not contain all required domains")
  return { modified, domains: ATTACK_DOMAINS.map((domain) => resolved.get(domain)!) }
}

function attackObjectType(stixType: string): AttackObjectType | undefined {
  if (stixType === "x-mitre-tactic") return "tactic"
  if (stixType === "attack-pattern") return "technique"
  if (stixType === "malware" || stixType === "tool") return "software"
  if (stixType === "intrusion-set") return "group"
}

function externalReference(value: Record<string, unknown>) {
  if (!Array.isArray(value.external_references)) return {}
  for (const candidate of value.external_references) {
    const reference = record(candidate)
    if (!reference || typeof reference.source_name !== "string" || !reference.source_name.startsWith("mitre-")) continue
    const attackID = typeof reference.external_id === "string" ? reference.external_id : undefined
    const url = typeof reference.url === "string" && reference.url.startsWith("https://attack.mitre.org/") ? reference.url : undefined
    if (attackID || url) return { attackID, url }
  }
  return {}
}

function canonicalAttackUrl(objectType: AttackObjectType, attackID: string) {
  const collection =
    objectType === "tactic" ? "tactics" : objectType === "technique" ? "techniques" : objectType === "software" ? "software" : "groups"
  const identifier = objectType === "technique" ? attackID.replace(".", "/") : attackID
  return `https://attack.mitre.org/${collection}/${identifier}/`
}

function json(value: unknown) {
  return JSON.stringify(value)
}

function createDatabase(file: string) {
  const database = new Database(file, { create: true, strict: true })
  database.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA page_size = 4096;
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE object (
      id INTEGER PRIMARY KEY,
      domain TEXT NOT NULL,
      stix_id TEXT NOT NULL,
      attack_id TEXT,
      object_type TEXT NOT NULL,
      stix_type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      aliases_json TEXT NOT NULL,
      platforms_json TEXT NOT NULL,
      tactics_json TEXT NOT NULL,
      created TEXT,
      modified TEXT,
      revoked INTEGER NOT NULL,
      deprecated INTEGER NOT NULL,
      subtechnique INTEGER NOT NULL,
      url TEXT,
      UNIQUE(domain, stix_id)
    );
    CREATE INDEX object_attack_id_idx ON object(attack_id, domain);
    CREATE INDEX object_type_domain_idx ON object(object_type, domain, name);
    CREATE VIRTUAL TABLE object_fts USING fts5(name, attack_id, aliases, description, content='');
    CREATE TABLE relationship (
      id INTEGER PRIMARY KEY,
      domain TEXT NOT NULL,
      stix_id TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      description TEXT NOT NULL,
      created TEXT,
      modified TEXT,
      revoked INTEGER NOT NULL,
      UNIQUE(domain, stix_id)
    );
    CREATE INDEX relationship_source_idx ON relationship(domain, source_ref, relationship_type);
    CREATE INDEX relationship_target_idx ON relationship(domain, target_ref, relationship_type);
    CREATE TABLE matrix (
      domain TEXT NOT NULL,
      stix_id TEXT NOT NULL,
      name TEXT NOT NULL,
      tactic_refs_json TEXT NOT NULL,
      PRIMARY KEY(domain, stix_id)
    ) WITHOUT ROWID;
  `)
  return database
}

function buildDomain(database: Database, domain: AttackDomain, value: unknown) {
  const bundle = record(value)
  if (!bundle || bundle.type !== "bundle" || !Array.isArray(bundle.objects)) throw new Error(`${domain} ATT&CK source is not a STIX bundle`)
  if (bundle.objects.length === 0 || bundle.objects.length > 100_000) throw new Error(`${domain} ATT&CK object count is invalid`)
  const rows = bundle.objects.map((item, index) => {
    const row = record(item)
    if (!row) throw new Error(`${domain} ATT&CK object ${index} is invalid`)
    const id = text(row.id, `${domain} STIX id`, 300)
    const type = text(row.type, `${domain} STIX type`, 100)
    if (!id.startsWith(`${type}--`)) throw new Error(`${domain} STIX id '${id}' does not match type '${type}'`)
    if (row.spec_version !== undefined && row.spec_version !== "2.1") throw new Error(`${domain} object '${id}' is not STIX 2.1`)
    return { row, id, type }
  }).sort((left, right) => left.id.localeCompare(right.id))
  const allIDs = new Set(rows.map((item) => item.id))
  if (allIDs.size !== rows.length) throw new Error(`${domain} ATT&CK bundle contains duplicate STIX ids`)
  const typesByID = new Map(rows.map((item) => [item.id, item.type]))
  const insertObject = database.query(`INSERT INTO object (
    domain, stix_id, attack_id, object_type, stix_type, name, description, aliases_json,
    platforms_json, tactics_json, created, modified, revoked, deprecated, subtechnique, url
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
  const insertFts = database.query("INSERT INTO object_fts(rowid, name, attack_id, aliases, description) VALUES (?, ?, ?, ?, ?)")
  const insertRelationship = database.query(`INSERT INTO relationship (
    domain, stix_id, relationship_type, source_ref, target_ref, description, created, modified, revoked
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insertMatrix = database.query("INSERT INTO matrix(domain, stix_id, name, tactic_refs_json) VALUES (?, ?, ?, ?)")
  let objects = 0
  let relationships = 0
  let matrices = 0
  database.transaction(() => {
    for (const { row, id, type } of rows) {
      const objectType = attackObjectType(type)
      if (objectType) {
        const requiredDomain = `${domain}-attack`
        const declaredDomains = stringArray(row.x_mitre_domains, 10)
        if (!declaredDomains.includes(requiredDomain)) {
          throw new Error(`${domain} object '${id}' does not declare ${requiredDomain}`)
        }
        const name = text(row.name, `${domain} object '${id}' name`, 10_000)
        const description = optionalText(row.description) ?? ""
        const aliases = [...new Set([...stringArray(row.aliases), ...stringArray(row.x_mitre_aliases)])].sort((left, right) => left.localeCompare(right))
        const platforms = stringArray(row.x_mitre_platforms)
        const tactics = Array.isArray(row.kill_chain_phases)
          ? [...new Set(row.kill_chain_phases.flatMap((candidate) => {
              const phase = record(candidate)
              return phase && typeof phase.phase_name === "string" ? [phase.phase_name] : []
            }))].sort((left, right) => left.localeCompare(right))
          : objectType === "tactic" && typeof row.x_mitre_shortname === "string"
            ? [row.x_mitre_shortname]
            : []
        const reference = externalReference(row)
        const identifierPattern =
          objectType === "tactic"
            ? /^TA\d{4}$/u
            : objectType === "technique"
              ? /^T\d{4}(?:\.\d{3})?$/u
              : objectType === "software"
                ? /^S\d{4}$/u
                : /^G\d{4}$/u
        if (!reference.attackID || !identifierPattern.test(reference.attackID)) {
          throw new Error(`${domain} object '${id}' has no valid ATT&CK external identifier`)
        }
        const url = reference.url ?? canonicalAttackUrl(objectType, reference.attackID)
        const result = insertObject.get(
          domain,
          id,
          reference.attackID ?? null,
          objectType,
          type,
          name,
          description,
          json(aliases),
          json(platforms),
          json(tactics),
          optionalText(row.created, 100) ?? null,
          optionalText(row.modified, 100) ?? null,
          row.revoked === true ? 1 : 0,
          row.x_mitre_deprecated === true ? 1 : 0,
          row.x_mitre_is_subtechnique === true ? 1 : 0,
          url,
        ) as { id: number }
        insertFts.run(result.id, name, reference.attackID ?? "", aliases.join(" "), description)
        objects++
        continue
      }
      if (type === "relationship") {
        const sourceRef = text(row.source_ref, `${domain} relationship source`, 300)
        const targetRef = text(row.target_ref, `${domain} relationship target`, 300)
        if (!allIDs.has(sourceRef) || !allIDs.has(targetRef)) {
          throw new Error(`${domain} relationship '${id}' references an object outside its bundle`)
        }
        insertRelationship.run(
          domain,
          id,
          text(row.relationship_type, `${domain} relationship type`, 100),
          sourceRef,
          targetRef,
          optionalText(row.description) ?? "",
          optionalText(row.created, 100) ?? null,
          optionalText(row.modified, 100) ?? null,
          row.revoked === true ? 1 : 0,
        )
        relationships++
        continue
      }
      if (type === "x-mitre-matrix") {
        const tacticRefs = stringArray(row.tactic_refs)
        if (tacticRefs.length === 0 || tacticRefs.some((reference) => typesByID.get(reference) !== "x-mitre-tactic")) {
          throw new Error(`${domain} matrix '${id}' contains invalid tactic references`)
        }
        insertMatrix.run(domain, id, text(row.name, `${domain} matrix name`, 10_000), json(tacticRefs))
        matrices++
      }
    }
  })()
  if (objects === 0) throw new Error(`${domain} ATT&CK bundle contained no supported objects`)
  if (relationships === 0) throw new Error(`${domain} ATT&CK bundle contained no supported relationships`)
  if (matrices === 0) throw new Error(`${domain} ATT&CK bundle contained no valid matrix`)
  return { objects, relationships }
}

function writeFile(file: string, value: Uint8Array | string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}

export async function buildAttackSnapshot(options: BuildAttackSnapshotOptions): Promise<AttackSnapshotManifest> {
  const fetchBytes = options.fetchBytes ?? fetchOfficialAttackBytes
  const now = options.now ?? (() => new Date())
  const output = path.resolve(options.outputDir)
  const temporary = `${output}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.rmSync(temporary, { recursive: true, force: true })
  fs.mkdirSync(path.join(temporary, "source"), { recursive: true })
  try {
    const indexBytes = await fetchBytes(ATTACK_INDEX_URL, INDEX_LIMIT)
    const index = resolveAttackIndex(parseJson(indexBytes, "MITRE ATT&CK index"))
    writeFile(path.join(temporary, "source", "index.json"), indexBytes)
    const databaseFile = path.join(temporary, "mitre-attack.sqlite")
    const database = createDatabase(databaseFile)
    const domains: AttackSnapshotDomain[] = []
    try {
      for (const selected of index.domains) {
        const bytes = await fetchBytes(selected.version.url, BUNDLE_LIMIT)
        const sourceFile = `source/${selected.domain}-attack-${selected.version.version}.json`
        writeFile(path.join(temporary, sourceFile), bytes)
        const counts = buildDomain(database, selected.domain, parseJson(bytes, `${selected.domain} ATT&CK bundle`))
        domains.push({
          domain: selected.domain,
          collection_id: selected.collection.id,
          collection_name: selected.collection.name,
          version: selected.version.version,
          modified: selected.version.modified,
          url: selected.version.url,
          source_file: sourceFile,
          sha256: sha256(bytes),
          bytes: bytes.byteLength,
          objects: counts.objects,
          relationships: counts.relationships,
        })
      }
      const metadata = database.query("INSERT INTO metadata(key, value) VALUES (?, ?)")
      metadata.run("schema_version", "1")
      metadata.run("index_modified", index.modified)
      metadata.run("domain_versions", json(Object.fromEntries(domains.map((item) => [item.domain, item.version]))))
      database.exec("PRAGMA optimize; VACUUM;")
    } finally {
      database.close()
    }
    const integrity = new Database(databaseFile, { readonly: true, strict: true })
    try {
      const result = integrity.query("PRAGMA integrity_check").get() as Record<string, unknown>
      if (!Object.values(result).includes("ok")) throw new Error("MITRE ATT&CK SQLite integrity check failed")
    } finally {
      integrity.close()
    }
    const databaseBytes = fs.readFileSync(databaseFile)
    const compressed = gzipSync(databaseBytes, { level: 9 })
    writeFile(path.join(temporary, "mitre-attack.sqlite.gz"), compressed)
    const licenseBytes = await fetchBytes(ATTACK_LICENSE_URL, LICENSE_LIMIT)
    const license = licenseBytes.toString("utf8")
    if (!license.includes("The MITRE Corporation") || !license.includes("royalty-free license")) {
      throw new Error("MITRE ATT&CK license is invalid")
    }
    writeFile(path.join(temporary, "LICENSE.txt"), licenseBytes)
    const databaseDigest = sha256(databaseBytes)
    const snapshotIdentity = sha256(
      json({
        index: sha256(indexBytes),
        domains: domains.map((item) => ({ domain: item.domain, version: item.version, sha256: item.sha256 })),
        database: databaseDigest,
      }),
    )
    const generatedAt = now().toISOString()
    const manifest: AttackSnapshotManifest = {
      schema_version: 1,
      snapshot_id: `attack-${domains.map((item) => `${item.domain}-${item.version}`).join("_")}-${snapshotIdentity.slice(0, 16)}`,
      generated_at: generatedAt,
      cyberful: { version: options.cyberfulVersion, build_id: options.buildID },
      index: {
        url: ATTACK_INDEX_URL,
        modified: index.modified,
        sha256: sha256(indexBytes),
        bytes: indexBytes.byteLength,
        source_file: "source/index.json",
      },
      domains,
      database: {
        schema_version: 1,
        file: "mitre-attack.sqlite",
        sha256: databaseDigest,
        bytes: databaseBytes.byteLength,
        gzip_file: "mitre-attack.sqlite.gz",
        gzip_sha256: sha256(compressed),
        gzip_bytes: compressed.byteLength,
      },
      license: {
        url: ATTACK_LICENSE_URL,
        file: "LICENSE.txt",
        sha256: sha256(licenseBytes),
        bytes: licenseBytes.byteLength,
      },
    }
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`
    writeFile(path.join(temporary, "manifest.json"), manifestBytes)
    const sbomBytes = `${JSON.stringify(
      {
        spdxVersion: "SPDX-2.3",
        dataLicense: "CC0-1.0",
        SPDXID: "SPDXRef-DOCUMENT",
        name: `Cyberful MITRE ATT&CK snapshot ${manifest.snapshot_id}`,
        documentNamespace: `https://cyberful.io/spdx/mitre-attack/${snapshotIdentity}`,
        creationInfo: { created: generatedAt, creators: [`Tool: Cyberful ${options.cyberfulVersion}`] },
        packages: domains.map((item) => ({
          SPDXID: `SPDXRef-Package-ATTACK-${item.domain}`,
          name: item.collection_name,
          versionInfo: item.version,
          downloadLocation: item.url,
          filesAnalyzed: false,
          licenseConcluded: "LicenseRef-MITRE-ATTACK",
          licenseDeclared: "LicenseRef-MITRE-ATTACK",
          copyrightText: "Copyright The MITRE Corporation",
          checksums: [{ algorithm: "SHA256", checksumValue: item.sha256 }],
        })),
        relationships: domains.map((item) => ({
          spdxElementId: "SPDXRef-DOCUMENT",
          relationshipType: "DESCRIBES",
          relatedSpdxElement: `SPDXRef-Package-ATTACK-${item.domain}`,
        })),
        hasExtractedLicensingInfos: [
          {
            licenseId: "LicenseRef-MITRE-ATTACK",
            name: "MITRE ATT&CK License",
            extractedText: license,
            seeAlsos: [ATTACK_LICENSE_URL],
          },
        ],
      },
      null,
      2,
    )}\n`
    writeFile(path.join(temporary, "SBOM.spdx.json"), sbomBytes)
    const checksums = [
      [sha256(manifestBytes), "manifest.json"],
      [sha256(sbomBytes), "SBOM.spdx.json"],
      [manifest.index.sha256, manifest.index.source_file],
      ...manifest.domains.map((item) => [item.sha256, item.source_file]),
      [manifest.database.sha256, manifest.database.file],
      [manifest.database.gzip_sha256, manifest.database.gzip_file],
      [manifest.license.sha256, manifest.license.file],
    ].map(([digest, file]) => `${digest}  ${file}`).join("\n")
    writeFile(path.join(temporary, "SHA256SUMS"), `${checksums}\n`)
    fs.rmSync(output, { recursive: true, force: true })
    fs.renameSync(temporary, output)
    return manifest
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

function verifiedSnapshotFile(directory: string, relative: string, expectedBytes: number, expectedSha256: string) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) {
    throw new Error(`MITRE ATT&CK snapshot contains an unsafe file path: ${relative}`)
  }
  const root = path.resolve(directory)
  const file = path.resolve(root, relative)
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    throw new Error(`MITRE ATT&CK snapshot file escapes its directory: ${relative}`)
  }
  const bytes = fs.readFileSync(file)
  if (bytes.byteLength !== expectedBytes || sha256(bytes) !== expectedSha256) {
    throw new Error(`MITRE ATT&CK snapshot digest or size mismatch: ${relative}`)
  }
  return bytes
}

export function validateAttackRoutingIdentifiers(databaseFile: string, identifiers: readonly string[]) {
  const requested = [...new Set(identifiers)]
  if (requested.length === 0 || requested.length > 512) throw new Error("MITRE ATT&CK routing identifier list is invalid")
  const database = new Database(databaseFile, { readonly: true, strict: true })
  try {
    const rows = database
      .query(`SELECT DISTINCT attack_id FROM object WHERE attack_id IN (${requested.map(() => "?").join(", ")})`)
      .all(...requested) as { attack_id: string }[]
    const present = new Set(rows.map((row) => row.attack_id))
    const missing = requested.filter((identifier) => !present.has(identifier))
    if (missing.length) {
      throw new Error(`MITRE ATT&CK routing identifiers are absent from the build snapshot: ${missing.join(", ")}`)
    }
  } finally {
    database.close()
  }
}

export function embeddedAttackSnapshot(directory: string): { manifest: AttackSnapshotManifest; database_gzip_base64: string; license: string } {
  const manifestBytes = fs.readFileSync(path.join(directory, "manifest.json"))
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as AttackSnapshotManifest
  if (manifest.schema_version !== 1 || manifest.database.schema_version !== 1) {
    throw new Error("MITRE ATT&CK snapshot manifest schema is unsupported")
  }
  if (
    manifest.domains.length !== ATTACK_DOMAINS.length ||
    manifest.domains.map((item) => item.domain).toSorted().join("\0") !== [...ATTACK_DOMAINS].toSorted().join("\0")
  ) {
    throw new Error("MITRE ATT&CK snapshot must contain Enterprise, Mobile, and ICS exactly once")
  }
  officialUrl(manifest.index.url)
  officialUrl(manifest.license.url)
  verifiedSnapshotFile(directory, manifest.index.source_file, manifest.index.bytes, manifest.index.sha256)
  for (const domain of manifest.domains) {
    officialUrl(domain.url)
    verifiedSnapshotFile(directory, domain.source_file, domain.bytes, domain.sha256)
  }
  const database = verifiedSnapshotFile(directory, manifest.database.file, manifest.database.bytes, manifest.database.sha256)
  const compressed = verifiedSnapshotFile(
    directory,
    manifest.database.gzip_file,
    manifest.database.gzip_bytes,
    manifest.database.gzip_sha256,
  )
  const restored = gunzipSync(compressed)
  if (restored.byteLength !== database.byteLength || sha256(restored) !== manifest.database.sha256) {
    throw new Error("MITRE ATT&CK compressed database does not restore the declared database")
  }
  const licenseBytes = verifiedSnapshotFile(directory, manifest.license.file, manifest.license.bytes, manifest.license.sha256)
  const license = licenseBytes.toString("utf8")
  if (!license.includes("The MITRE Corporation") || !license.includes("royalty-free license")) {
    throw new Error("MITRE ATT&CK embedded license is invalid")
  }
  const expectedChecksums = [
    [sha256(manifestBytes), "manifest.json"],
    [sha256(fs.readFileSync(path.join(directory, "SBOM.spdx.json"))), "SBOM.spdx.json"],
    [manifest.index.sha256, manifest.index.source_file],
    ...manifest.domains.map((item) => [item.sha256, item.source_file]),
    [manifest.database.sha256, manifest.database.file],
    [manifest.database.gzip_sha256, manifest.database.gzip_file],
    [manifest.license.sha256, manifest.license.file],
  ]
    .map(([digest, file]) => `${digest}  ${file}`)
    .join("\n")
  if (fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8") !== `${expectedChecksums}\n`) {
    throw new Error("MITRE ATT&CK snapshot checksum manifest is inconsistent")
  }
  return { manifest, database_gzip_base64: compressed.toString("base64"), license }
}
