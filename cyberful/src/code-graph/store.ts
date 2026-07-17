// ── Code Graph SQLite Store ─────────────────────────────────────────────────
// Owns the private WAL database for snapshots, current graph state, summaries,
// coverage, findings, and status transitions. Mutations are synchronous SQLite
// transactions invoked by the engine's single write queue; readers only see a
// complete previous or complete next index, never a half-rebuilt graph.
// ─────────────────────────────────────────────────────────────────────────────

import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import {
  findingConfidences,
  findingWorkflows,
  findingSeverities,
  findingStatuses,
  graphEdgeKinds,
  graphNodeKinds,
  securityTags,
  type AnalysisCoverage,
  type FileCoverage,
  type FindingFilter,
  type FindingEvidence,
  type FindingLocation,
  type FindingStatus,
  type FindingTrace,
  type FindingTransitionRecord,
  type GraphAttribute,
  type GraphEdge,
  type GraphNode,
  type SecurityFinding,
  type SecurityFindingInput,
  type SecurityTag,
} from "./types"

export interface StoredFileState {
  readonly path: string
  readonly language: string
  readonly contentHash: string
  readonly analysisFingerprint: string
  readonly size: number
}

export interface StoredReference {
  readonly id: string
  readonly file: string
  readonly fromNodeId: string
  readonly targetName: string
  readonly kind: GraphEdge["kind"]
  readonly line: number
  readonly targetLanguage?: string
  readonly evidence?: string
}

export interface StoredSummary {
  readonly nodeId: string
  readonly reads: readonly string[]
  readonly writes: readonly string[]
  readonly sources: readonly string[]
  readonly sinks: readonly string[]
  readonly guards: readonly string[]
  readonly callees: readonly string[]
  readonly fingerprint: string
}

export type GraphSummarizer = (nodes: readonly GraphNode[], edges: readonly GraphEdge[]) => readonly StoredSummary[]

export const REFERENCE_RESOLUTION_ALGORITHM_VERSION = 3 as const
export const REFERENCE_RESOLUTION_CANDIDATE_LIMIT = 16 as const

export interface ReferenceResolutionMetrics {
  readonly algorithmVersion: typeof REFERENCE_RESOLUTION_ALGORITHM_VERSION
  readonly nodes: number
  readonly references: number
  readonly candidateProbes: number
  readonly resolvedTargets: number
  readonly truncatedReferences: number
}

export interface StoredSnapshot {
  readonly id: string
  readonly root: string
  readonly fingerprint: string
  readonly label?: string
  readonly createdAt: string
}

export interface IndexMutation {
  readonly snapshot: StoredSnapshot
  readonly removed: readonly string[]
  readonly invalidated: readonly string[]
  readonly files: readonly { readonly state: StoredFileState; readonly coverage: FileCoverage }[]
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  readonly references: readonly StoredReference[]
}

interface FileRow {
  readonly path: string
  readonly language: string
  readonly content_hash: string
  readonly analysis_fingerprint: string
  readonly size: number
  readonly coverage_json: string
}

interface NodeRow {
  readonly id: string
  readonly file_path: string
  readonly language: string
  readonly local_key: string
  readonly kind: string
  readonly name: string
  readonly line: number
  readonly column_number: number
  readonly end_line: number
  readonly tags_json: string
  readonly attributes_json: string
}

interface EdgeRow {
  readonly id: string
  readonly source_node_id: string
  readonly target_node_id: string
  readonly source_file: string
  readonly target_file: string
  readonly kind: string
  readonly weight: number
  readonly evidence: string | null
  readonly interprocedural: number
}

interface ReferenceRow {
  readonly id: string
  readonly file_path: string
  readonly from_node_id: string
  readonly target_name: string
  readonly kind: string
  readonly line: number
  readonly target_language: string | null
  readonly evidence: string | null
}

interface SnapshotRow {
  readonly id: string
  readonly root: string
  readonly fingerprint: string
  readonly label: string | null
  readonly created_at: string
}

interface FindingRow {
  readonly id: string
  readonly workflow: string
  readonly title: string
  readonly weakness: string
  readonly severity: string
  readonly confidence: string
  readonly status: string
  readonly locations_json: string
  readonly traces_json: string
  readonly evidence_json: string
  readonly remediation: string
  readonly base_ref: string | null
  readonly head_ref: string | null
  readonly related_json: string
  readonly created_at: string
  readonly updated_at: string
}

interface TransitionRow {
  readonly id: string
  readonly finding_id: string
  readonly from_status: string
  readonly to_status: string
  readonly reason: string
  readonly created_at: string
}

const schema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS graph_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  language TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  analysis_fingerprint TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size >= 0),
  coverage_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  language TEXT NOT NULL,
  local_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  line INTEGER NOT NULL CHECK(line > 0),
  column_number INTEGER NOT NULL CHECK(column_number > 0),
  end_line INTEGER NOT NULL CHECK(end_line >= line),
  tags_json TEXT NOT NULL,
  attributes_json TEXT NOT NULL,
  UNIQUE(file_path, local_key)
) STRICT;

CREATE TABLE IF NOT EXISTS graph_references (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  from_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL CHECK(line > 0),
  target_language TEXT,
  evidence TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  source_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source_file TEXT NOT NULL,
  target_file TEXT NOT NULL,
  kind TEXT NOT NULL,
  weight REAL NOT NULL CHECK(weight >= 0),
  evidence TEXT,
  interprocedural INTEGER NOT NULL CHECK(interprocedural IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS summaries (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  reads_json TEXT NOT NULL,
  writes_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  sinks_json TEXT NOT NULL,
  guards_json TEXT NOT NULL,
  callees_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  title TEXT NOT NULL,
  weakness TEXT NOT NULL,
  severity TEXT NOT NULL,
  confidence TEXT NOT NULL,
  status TEXT NOT NULL,
  locations_json TEXT NOT NULL,
  traces_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  remediation TEXT NOT NULL,
  base_ref TEXT,
  head_ref TEXT,
  related_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS finding_transitions (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS nodes_name_idx ON nodes(name);
CREATE INDEX IF NOT EXISTS nodes_file_kind_idx ON nodes(file_path, kind);
CREATE INDEX IF NOT EXISTS edges_source_idx ON edges(source_node_id, kind);
CREATE INDEX IF NOT EXISTS edges_target_idx ON edges(target_node_id, kind);
CREATE INDEX IF NOT EXISTS edges_target_file_idx ON edges(target_file, source_file);
CREATE INDEX IF NOT EXISTS references_target_idx ON graph_references(target_name, kind);
CREATE INDEX IF NOT EXISTS findings_status_severity_idx ON findings(status, severity);
`

const REFERENCE_TRUNCATION_PREFIX = "Reference resolution candidate cap reached"

function hash(...values: readonly string[]) {
  const digest = createHash("sha256")
  values.forEach((value) => digest.update(value).update("\0"))
  return digest.digest("hex")
}

function parseArray<T>(raw: string, validate: (value: unknown) => value is T): T[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || !parsed.every(validate))
    throw new Error("Stored code graph JSON has an invalid array shape.")
  return parsed
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isSecurityTag(value: unknown): value is SecurityTag {
  return typeof value === "string" && securityTags.some((tag) => tag === value)
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  const match = typeof value === "string" ? values.find((candidate) => candidate === value) : undefined
  if (match === undefined) throw new Error(`Stored ${label} has an invalid value.`)
  return match
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isGraphAttribute(value: unknown): value is GraphAttribute {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

function isOptionalInteger(value: unknown) {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
}

function isFindingLocation(value: unknown): value is FindingLocation {
  if (!isObject(value)) return false
  return (
    typeof value.path === "string" &&
    typeof value.startLine === "number" &&
    Number.isSafeInteger(value.startLine) &&
    value.startLine > 0 &&
    isOptionalInteger(value.startColumn) &&
    isOptionalInteger(value.endLine) &&
    isOptionalInteger(value.endColumn) &&
    (value.nodeId === undefined || typeof value.nodeId === "string") &&
    (value.message === undefined || typeof value.message === "string")
  )
}

function isFindingTrace(value: unknown): value is FindingTrace {
  if (!isObject(value)) return false
  return (
    Array.isArray(value.nodes) &&
    value.nodes.every(isString) &&
    Array.isArray(value.edges) &&
    value.edges.every(isString) &&
    (value.description === undefined || typeof value.description === "string")
  )
}

function isFindingEvidence(value: unknown): value is FindingEvidence {
  if (!isObject(value)) return false
  return (
    typeof value.kind === "string" &&
    ["code", "test", "configuration", "runtime", "manual"].includes(value.kind) &&
    typeof value.description === "string" &&
    (value.fingerprint === undefined || typeof value.fingerprint === "string") &&
    (value.location === undefined || isFindingLocation(value.location))
  )
}

function isCapability(value: unknown) {
  if (!isObject(value)) return false
  return (
    typeof value.level === "string" &&
    ["exact", "heuristic", "structural", "unsupported"].includes(value.level) &&
    typeof value.detail === "string"
  )
}

function isAnalysisCoverage(value: unknown): value is AnalysisCoverage {
  if (!isObject(value) || !isObject(value.capabilities)) return false
  const capabilities = value.capabilities
  return (
    typeof value.parser === "string" &&
    ["grammar", "semantic-lexer", "declarative", "unavailable"].includes(value.parser) &&
    typeof value.confidence === "number" &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    [
      "parsing",
      "symbols",
      "controlFlow",
      "callGraph",
      "dataFlow",
      "aliasing",
      "summaries",
      "securitySemantics",
      "crossLanguage",
    ].every((key) => isCapability(capabilities[key])) &&
    Array.isArray(value.limitations) &&
    value.limitations.every(isString)
  )
}

function parseCoverage(raw: string, expectedPath: string): FileCoverage {
  const parsed: unknown = JSON.parse(raw)
  if (!isObject(parsed) || !isAnalysisCoverage(parsed.coverage))
    throw new Error(`Stored coverage for ${expectedPath} has an invalid shape.`)
  if (
    parsed.path !== expectedPath ||
    typeof parsed.language !== "string" ||
    typeof parsed.contentHash !== "string" ||
    typeof parsed.status !== "string" ||
    !["indexed", "degraded", "excluded", "unsupported", "error"].includes(parsed.status) ||
    !Array.isArray(parsed.diagnostics) ||
    !parsed.diagnostics.every(isString)
  )
    throw new Error(`Stored coverage for ${expectedPath} has invalid fields.`)
  const status = enumValue(
    parsed.status,
    ["indexed", "degraded", "excluded", "unsupported", "error"] as const,
    "coverage status",
  )
  return {
    path: parsed.path,
    language: parsed.language,
    contentHash: parsed.contentHash,
    status,
    coverage: parsed.coverage,
    diagnostics: parsed.diagnostics,
  }
}

function parseAttributes(raw: string) {
  const parsed: unknown = JSON.parse(raw)
  if (!isObject(parsed)) throw new Error("Stored code graph attributes have an invalid shape.")

  const attributes: Record<string, GraphAttribute> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!isGraphAttribute(value)) throw new Error("Stored code graph attributes have an invalid shape.")
    attributes[key] = value
  }
  return attributes
}

function nodeFromRow(row: NodeRow): GraphNode {
  return {
    id: row.id,
    file: row.file_path,
    language: row.language,
    kind: enumValue(row.kind, graphNodeKinds, "node kind"),
    name: row.name,
    line: row.line,
    column: row.column_number,
    endLine: row.end_line,
    tags: parseArray(row.tags_json, isSecurityTag),
    attributes: { ...parseAttributes(row.attributes_json), localKey: row.local_key },
  }
}

function edgeFromRow(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    source: row.source_node_id,
    target: row.target_node_id,
    sourceFile: row.source_file,
    targetFile: row.target_file,
    kind: enumValue(row.kind, graphEdgeKinds, "edge kind"),
    weight: row.weight,
    evidence: row.evidence ?? undefined,
    interprocedural: row.interprocedural === 1,
  }
}

function referenceTargetNames(node: GraphNode) {
  return new Set(
    [node.name, node.name.split(/::|\.|\/|\\/).at(-1)]
      .filter((name): name is string => Boolean(name))
      .map((name) => name.toLowerCase()),
  )
}

function findingFromRow(row: FindingRow): SecurityFinding {
  const locations = parseArray(row.locations_json, isFindingLocation)
  const traces = parseArray(row.traces_json, isFindingTrace)
  const evidence = parseArray(row.evidence_json, isFindingEvidence)
  const related = parseArray(row.related_json, isString)
  return {
    id: row.id,
    workflow: enumValue(row.workflow, findingWorkflows, "finding workflow"),
    title: row.title,
    weakness: row.weakness,
    severity: enumValue(row.severity, findingSeverities, "finding severity"),
    confidence: enumValue(row.confidence, findingConfidences, "finding confidence"),
    status: enumValue(row.status, findingStatuses, "finding status"),
    locations,
    traces,
    evidence,
    remediation: row.remediation,
    base: row.base_ref ?? undefined,
    head: row.head_ref ?? undefined,
    relatedFindings: related,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── Interprocedural Resolution Is Rebuilt From Durable References ──────────
// A changed definition can resolve a call that used to be unknown, and a
// deleted definition can invalidate callers that did not themselves change.
// References therefore survive as first-class rows. After each index mutation
// only derived interprocedural edges are rebuilt, keeping local analysis
// incremental while ensuring global name resolution never goes stale.
// Candidate expansion remains bounded for collision-heavy repositories. When
// that budget omits valid targets, the owning file is explicitly degraded so
// callers can see the incomplete edge set instead of inferring full coverage.
// ─────────────────────────────────────────────────────────────────────────────

export class CodeGraphStore {
  readonly #database: Database

  constructor(databasePath: string) {
    this.#database = new Database(databasePath, { create: true, strict: true })
    this.#database.run("PRAGMA journal_mode = WAL")
    this.#database.run("PRAGMA synchronous = NORMAL")
    this.#database.run("PRAGMA busy_timeout = 5000")
    this.#database.run("PRAGMA wal_autocheckpoint = 1000")
    this.#database.run("PRAGMA temp_store = FILE")
    this.#database.run("PRAGMA foreign_keys = ON")
    this.#database.exec(schema)
    const fileColumns = this.#database
      .query<{ readonly name: string }, []>("PRAGMA table_info(files)")
      .all()
      .map((column) => column.name)
    if (!fileColumns.includes("analysis_fingerprint")) {
      this.#database.run("ALTER TABLE files ADD COLUMN analysis_fingerprint TEXT NOT NULL DEFAULT ''")
    }
    const findingColumns = this.#database
      .query<{ readonly name: string }, []>("PRAGMA table_info(findings)")
      .all()
      .map((column) => column.name)
    if (!findingColumns.includes("workflow") && findingColumns.includes("mode")) {
      this.#database.run("ALTER TABLE findings RENAME COLUMN mode TO workflow")
    }
    this.#database.run(
      "INSERT INTO graph_metadata(key, value) VALUES ('schema_version', '3') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    this.#database.exec(`
      CREATE TEMP TABLE IF NOT EXISTS desired_interprocedural_edges (
        id TEXT PRIMARY KEY,
        source_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        source_file TEXT NOT NULL,
        target_file TEXT NOT NULL,
        kind TEXT NOT NULL,
        weight REAL NOT NULL,
        evidence TEXT
      ) STRICT;
    `)
  }

  close() {
    this.#database.run("PRAGMA wal_checkpoint(TRUNCATE)")
    this.#database.close()
  }

  fileStates() {
    return new Map(
      this.#database
        .query<FileRow, []>(
          "SELECT path, language, content_hash, analysis_fingerprint, size, coverage_json FROM files ORDER BY path",
        )
        .all()
        .map((row) => [
          row.path,
          {
            path: row.path,
            language: row.language,
            contentHash: row.content_hash,
            analysisFingerprint: row.analysis_fingerprint,
            size: row.size,
          } satisfies StoredFileState,
        ]),
    )
  }

  applyIndex(mutation: IndexMutation, summarize: GraphSummarizer) {
    const graphChanged =
      mutation.removed.length > 0 ||
      mutation.invalidated.length > 0 ||
      mutation.files.length > 0 ||
      mutation.nodes.length > 0 ||
      mutation.edges.length > 0 ||
      mutation.references.length > 0
    const existingNodeCount =
      this.#database.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM nodes").get()?.count ?? 0
    const existingReferenceCount =
      this.#database.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM graph_references").get()
        ?.count ?? 0
    const mutationContainsWholeGraph = existingNodeCount === 0 && existingReferenceCount === 0
    const commit = this.#database.transaction(() => {
      this.#database
        .query("INSERT INTO snapshots(id, root, fingerprint, label, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(
          mutation.snapshot.id,
          mutation.snapshot.root,
          mutation.snapshot.fingerprint,
          mutation.snapshot.label ?? null,
          mutation.snapshot.createdAt,
        )

      if (!graphChanged) return this.#referenceResolutionMetrics()

      const deleteFile = this.#database.query("DELETE FROM files WHERE path = ?")
      mutation.removed.forEach((path) => deleteFile.run(path))

      const deleteNodes = this.#database.query("DELETE FROM nodes WHERE file_path = ?")
      mutation.invalidated.forEach((path) => deleteNodes.run(path))

      const upsertFile = this.#database.query(`
        INSERT INTO files(path, snapshot_id, language, content_hash, analysis_fingerprint, size, coverage_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          snapshot_id = excluded.snapshot_id,
          language = excluded.language,
          content_hash = excluded.content_hash,
          analysis_fingerprint = excluded.analysis_fingerprint,
          size = excluded.size,
          coverage_json = excluded.coverage_json
      `)
      mutation.files.forEach((file) =>
        upsertFile.run(
          file.state.path,
          mutation.snapshot.id,
          file.state.language,
          file.state.contentHash,
          file.state.analysisFingerprint,
          file.state.size,
          JSON.stringify(file.coverage),
        ),
      )

      const insertNode = this.#database.query(`
        INSERT INTO nodes(id, file_path, language, local_key, kind, name, line, column_number, end_line, tags_json, attributes_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      mutation.nodes.forEach((node) =>
        insertNode.run(
          node.id,
          node.file,
          node.language,
          String(node.attributes.localKey ?? node.id),
          node.kind,
          node.name,
          node.line,
          node.column,
          node.endLine,
          JSON.stringify(node.tags),
          JSON.stringify(Object.fromEntries(Object.entries(node.attributes).filter(([key]) => key !== "localKey"))),
        ),
      )

      const insertReference = this.#database.query(`
        INSERT INTO graph_references(id, file_path, from_node_id, target_name, kind, line, target_language, evidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      mutation.references.forEach((reference) =>
        insertReference.run(
          reference.id,
          reference.file,
          reference.fromNodeId,
          reference.targetName,
          reference.kind,
          reference.line,
          reference.targetLanguage ?? null,
          reference.evidence ?? null,
        ),
      )

      const insertEdge = this.#database.query(`
        INSERT OR REPLACE INTO edges(id, source_node_id, target_node_id, source_file, target_file, kind, weight, evidence, interprocedural)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      mutation.edges.forEach((edge) =>
        insertEdge.run(
          edge.id,
          edge.source,
          edge.target,
          edge.sourceFile,
          edge.targetFile,
          edge.kind,
          edge.weight,
          edge.evidence ?? null,
          edge.interprocedural ? 1 : 0,
        ),
      )

      this.#database.run("DELETE FROM desired_interprocedural_edges")
      const insertDesiredEdge = this.#database.query(`
        INSERT OR REPLACE INTO desired_interprocedural_edges(
          id, source_node_id, target_node_id, source_file, target_file, kind, weight, evidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const references = mutationContainsWholeGraph ? mutation.references : this.references()
      const nodes = mutationContainsWholeGraph ? mutation.nodes : this.nodes()
      let candidateProbes = 0
      let resolvedTargets = 0
      let truncatedReferences = 0
      const truncations = new Map<string, { count: number; targets: Set<string> }>()
      const nodeById = new Map(nodes.map((node) => [node.id, node]))
      const exact = new Map<string, GraphNode[]>()
      const exactByLanguage = new Map<string, GraphNode[]>()
      nodes.forEach((node) => {
        const names = new Set(
          [node.name, node.name.split(/::|\.|\/|\\/).at(-1)].filter((name): name is string => Boolean(name)),
        )
        names.forEach((name) => {
          const key = name.toLowerCase()
          const candidates = exact.get(key) ?? []
          candidates.push(node)
          exact.set(key, candidates)
          const languageKey = `${node.language}\0${key}`
          const languageCandidates = exactByLanguage.get(languageKey) ?? []
          languageCandidates.push(node)
          exactByLanguage.set(languageKey, languageCandidates)
        })
      })
      references.forEach((reference) => {
        const targetKey =
          reference.targetName
            .split(/::|\.|\/|\\/)
            .at(-1)
            ?.toLowerCase() ?? reference.targetName.toLowerCase()
        const source = nodeById.get(reference.fromNodeId)
        if (!source) return
        const candidates: GraphNode[] = []
        const candidatePool = reference.targetLanguage
          ? (exactByLanguage.get(`${reference.targetLanguage}\0${targetKey}`) ?? [])
          : (exact.get(targetKey) ?? [])
        const sourceIsCandidate =
          referenceTargetNames(source).has(targetKey) &&
          (reference.targetLanguage === undefined || source.language === reference.targetLanguage)
        if (candidatePool.length - Number(sourceIsCandidate) > REFERENCE_RESOLUTION_CANDIDATE_LIMIT) {
          truncatedReferences += 1
          const truncation = truncations.get(reference.file) ?? { count: 0, targets: new Set<string>() }
          truncation.count += 1
          if (truncation.targets.size < 5) truncation.targets.add(reference.targetName)
          truncations.set(reference.file, truncation)
        }
        for (const candidate of candidatePool) {
          candidateProbes += 1
          if (candidate.id === reference.fromNodeId) continue
          candidates.push(candidate)
          if (candidates.length === REFERENCE_RESOLUTION_CANDIDATE_LIMIT) break
        }
        candidates.forEach((target) => {
          resolvedTargets += 1
          const id = hash("edge", reference.fromNodeId, target.id, reference.kind)
          insertDesiredEdge.run(
            id,
            reference.fromNodeId,
            target.id,
            source.file,
            target.file,
            reference.kind,
            reference.kind === "call" ? 1 : 1.5,
            reference.evidence ?? null,
          )
          if (reference.kind === "call") {
            insertDesiredEdge.run(
              hash("edge", target.id, reference.fromNodeId, "data", "return-summary"),
              target.id,
              reference.fromNodeId,
              target.file,
              source.file,
              "data",
              1,
              "return-summary",
            )
          }
        })
      })
      this.#database.run(`
        DELETE FROM edges
        WHERE interprocedural = 1
          AND id NOT IN (SELECT id FROM desired_interprocedural_edges)
      `)
      this.#database.run(`
        INSERT INTO edges(
          id, source_node_id, target_node_id, source_file, target_file, kind, weight, evidence, interprocedural
        )
        SELECT id, source_node_id, target_node_id, source_file, target_file, kind, weight, evidence, 1
        FROM desired_interprocedural_edges
        WHERE true
        ON CONFLICT(id) DO UPDATE SET
          source_node_id = excluded.source_node_id,
          target_node_id = excluded.target_node_id,
          source_file = excluded.source_file,
          target_file = excluded.target_file,
          kind = excluded.kind,
          weight = excluded.weight,
          evidence = excluded.evidence,
          interprocedural = 1
        WHERE source_node_id != excluded.source_node_id
           OR target_node_id != excluded.target_node_id
           OR source_file != excluded.source_file
           OR target_file != excluded.target_file
           OR kind != excluded.kind
           OR weight != excluded.weight
           OR evidence IS NOT excluded.evidence
           OR interprocedural != 1
      `)
      this.#writeReferenceResolutionCoverage(truncations)
      this.#writeSummaries(summarize(nodes, this.edges()))
      const metrics = {
        algorithmVersion: REFERENCE_RESOLUTION_ALGORITHM_VERSION,
        nodes: nodes.length,
        references: references.length,
        candidateProbes,
        resolvedTargets,
        truncatedReferences,
      } satisfies ReferenceResolutionMetrics
      this.#database
        .query("INSERT OR REPLACE INTO graph_metadata(key, value) VALUES ('reference_resolution_metrics', ?)")
        .run(JSON.stringify(metrics))
      return metrics
    })
    const result = commit.immediate()
    this.#database.run("PRAGMA wal_checkpoint(TRUNCATE)")
    return result
  }

  #referenceResolutionMetrics(): ReferenceResolutionMetrics {
    const row = this.#database
      .query<
        { readonly value: string },
        []
      >("SELECT value FROM graph_metadata WHERE key = 'reference_resolution_metrics'")
      .get()
    if (row) {
      const parsed: unknown = JSON.parse(row.value)
      if (
        isObject(parsed) &&
        parsed.algorithmVersion === REFERENCE_RESOLUTION_ALGORITHM_VERSION &&
        [
          parsed.nodes,
          parsed.references,
          parsed.candidateProbes,
          parsed.resolvedTargets,
          parsed.truncatedReferences,
        ].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      )
        return parsed as unknown as ReferenceResolutionMetrics
    }
    return {
      algorithmVersion: REFERENCE_RESOLUTION_ALGORITHM_VERSION,
      nodes:
        this.#database.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM nodes").get()?.count ?? 0,
      references:
        this.#database.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM graph_references").get()
          ?.count ?? 0,
      candidateProbes: 0,
      resolvedTargets: 0,
      truncatedReferences: 0,
    }
  }

  references() {
    return this.#database
      .query<ReferenceRow, []>("SELECT * FROM graph_references ORDER BY file_path, line, id")
      .all()
      .map(
        (row): StoredReference => ({
          id: row.id,
          file: row.file_path,
          fromNodeId: row.from_node_id,
          targetName: row.target_name,
          kind: enumValue(row.kind, graphEdgeKinds, "reference kind"),
          line: row.line,
          targetLanguage: row.target_language ?? undefined,
          evidence: row.evidence ?? undefined,
        }),
      )
  }

  nodes() {
    return this.#database.query<NodeRow, []>("SELECT * FROM nodes ORDER BY file_path, line, id").all().map(nodeFromRow)
  }

  edges() {
    return this.#database
      .query<EdgeRow, []>("SELECT * FROM edges ORDER BY source_node_id, target_node_id, kind")
      .all()
      .map(edgeFromRow)
  }

  coverage() {
    return this.#database
      .query<FileRow, []>(
        "SELECT path, language, content_hash, analysis_fingerprint, size, coverage_json FROM files ORDER BY path",
      )
      .all()
      .map((row) => parseCoverage(row.coverage_json, row.path))
  }

  #writeReferenceResolutionCoverage(
    truncations: ReadonlyMap<string, { readonly count: number; readonly targets: ReadonlySet<string> }>,
  ) {
    const update = this.#database.query("UPDATE files SET coverage_json = ? WHERE path = ? AND coverage_json != ?")
    this.coverage().forEach((coverage) => {
      const truncation = truncations.get(coverage.path)
      const diagnostics = coverage.diagnostics.filter((message) => !message.startsWith(REFERENCE_TRUNCATION_PREFIX))
      const limitations = coverage.coverage.limitations.filter(
        (message) => !message.startsWith(REFERENCE_TRUNCATION_PREFIX),
      )
      if (truncation) {
        const examples = [...truncation.targets].join(", ")
        const message = `${REFERENCE_TRUNCATION_PREFIX} for ${truncation.count} reference(s): only the first ${REFERENCE_RESOLUTION_CANDIDATE_LIMIT} matching symbols were linked; interprocedural edges may be incomplete${examples ? ` (targets: ${examples})` : ""}.`
        diagnostics.push(message)
        limitations.push(message)
      }
      const status =
        coverage.status === "indexed" || coverage.status === "degraded"
          ? diagnostics.length > 0
            ? "degraded"
            : "indexed"
          : coverage.status
      const serialized = JSON.stringify({
        ...coverage,
        status,
        coverage: { ...coverage.coverage, limitations },
        diagnostics,
      } satisfies FileCoverage)
      update.run(serialized, coverage.path, serialized)
    })
  }

  latestSnapshot(): StoredSnapshot | undefined {
    const row = this.#database
      .query<SnapshotRow, []>("SELECT * FROM snapshots ORDER BY created_at DESC, id DESC LIMIT 1")
      .get()
    if (!row) return
    return {
      id: row.id,
      root: row.root,
      fingerprint: row.fingerprint,
      label: row.label ?? undefined,
      createdAt: row.created_at,
    }
  }

  #writeSummaries(summaries: readonly StoredSummary[]) {
    const insert = this.#database.query(`
      INSERT INTO summaries(node_id, reads_json, writes_json, sources_json, sinks_json, guards_json, callees_json, fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        reads_json = excluded.reads_json,
        writes_json = excluded.writes_json,
        sources_json = excluded.sources_json,
        sinks_json = excluded.sinks_json,
        guards_json = excluded.guards_json,
        callees_json = excluded.callees_json,
        fingerprint = excluded.fingerprint
      WHERE summaries.fingerprint != excluded.fingerprint
    `)
    summaries.forEach((summary) =>
      insert.run(
        summary.nodeId,
        JSON.stringify(summary.reads),
        JSON.stringify(summary.writes),
        JSON.stringify(summary.sources),
        JSON.stringify(summary.sinks),
        JSON.stringify(summary.guards),
        JSON.stringify(summary.callees),
        summary.fingerprint,
      ),
    )
  }

  upsertFinding(finding: SecurityFinding) {
    this.#database
      .query(
        `
        INSERT INTO findings(id, workflow, title, weakness, severity, confidence, status, locations_json, traces_json, evidence_json, remediation, base_ref, head_ref, related_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workflow = excluded.workflow,
          title = excluded.title,
          weakness = excluded.weakness,
          severity = excluded.severity,
          confidence = excluded.confidence,
          locations_json = excluded.locations_json,
          traces_json = excluded.traces_json,
          evidence_json = excluded.evidence_json,
          remediation = excluded.remediation,
          base_ref = excluded.base_ref,
          head_ref = excluded.head_ref,
          related_json = excluded.related_json,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        finding.id,
        finding.workflow,
        finding.title,
        finding.weakness,
        finding.severity,
        finding.confidence,
        finding.status,
        JSON.stringify(finding.locations),
        JSON.stringify(finding.traces ?? []),
        JSON.stringify(finding.evidence),
        finding.remediation,
        finding.base ?? null,
        finding.head ?? null,
        JSON.stringify(finding.relatedFindings ?? []),
        finding.createdAt,
        finding.updatedAt,
      )
  }

  findings(_filter: FindingFilter = {}) {
    const rows = this.#database.query<FindingRow, []>("SELECT * FROM findings ORDER BY updated_at DESC, id").all()
    return rows.map(findingFromRow)
  }

  finding(id: string) {
    const row = this.#database.query<FindingRow, [string]>("SELECT * FROM findings WHERE id = ?").get(id)
    return row ? findingFromRow(row) : undefined
  }

  transition(input: { readonly record: FindingTransitionRecord; readonly expected: FindingStatus }) {
    const commit = this.#database.transaction(() => {
      const result = this.#database
        .query("UPDATE findings SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
        .run(input.record.toStatus, input.record.createdAt, input.record.findingId, input.expected)
      if (result.changes !== 1)
        throw new Error(`Finding ${input.record.findingId} changed concurrently or does not exist.`)
      this.#database
        .query(
          "INSERT INTO finding_transitions(id, finding_id, from_status, to_status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.record.id,
          input.record.findingId,
          input.record.fromStatus,
          input.record.toStatus,
          input.record.reason,
          input.record.createdAt,
        )
    })
    commit.immediate()
  }

  transitions() {
    return this.#database
      .query<TransitionRow, []>("SELECT * FROM finding_transitions ORDER BY created_at, id")
      .all()
      .map(
        (row): FindingTransitionRecord => ({
          id: row.id,
          findingId: row.finding_id,
          fromStatus: enumValue(row.from_status, findingStatuses, "transition source status"),
          toStatus: enumValue(row.to_status, findingStatuses, "transition target status"),
          reason: row.reason,
          createdAt: row.created_at,
        }),
      )
  }
}

export function findingIdentity(input: SecurityFindingInput) {
  const primary = input.locations[0]
  return hash(
    "finding",
    input.weakness.trim().toUpperCase(),
    input.title.trim().toLowerCase(),
    primary?.path ?? "",
    String(primary?.startLine ?? 0),
  )
}

export function transitionIdentity(
  findingId: string,
  from: FindingStatus,
  to: FindingStatus,
  reason: string,
  at: string,
) {
  return hash("finding-transition", findingId, from, to, reason, at)
}
