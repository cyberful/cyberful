// ── Code Graph Gateway Tool Adapter ──────────────────────────────
// Projects the host-owned Code Graph and finding ledger into one phase gateway
// with lazy service creation, canonical source selection, fixed Code Audit
// exports, and explicit lifecycle cleanup.
// → cyberful/src/code-graph/service.ts — owns indexing, queries, ledger, and exports.
// → cyberful/src/subsystem/gateway/server.ts — owns one adapter per gateway lifecycle.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises"
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { parseSecurityFindingInput } from "../../code-graph/ledger"
import { createCodeGraphService, type CodeGraphService, type FindingIntegrityState } from "../../code-graph/service"
import { findingIdentity } from "../../code-graph/store"
import type { FindingTransitionRecord, SecurityFinding } from "../../code-graph/types"
import { resolveEffectiveSource } from "./source-tools"

const CODE_GRAPH_WORKFLOWS = ["code-audit"] as const
type CodeGraphWorkflow = (typeof CODE_GRAPH_WORKFLOWS)[number]

const findingStatuses = ["suspected", "confirmed", "dismissed"] as const
const findingSeverities = ["critical", "high", "medium", "low", "info"] as const
const findingWorkflows = ["code-audit"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nodeErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

function isFindingStatus(value: unknown): value is SecurityFinding["status"] {
  return typeof value === "string" && findingStatuses.some((status) => status === value)
}

const edgeKinds = [
  "contains",
  "control",
  "data",
  "call",
  "import",
  "inherits",
  "implements",
  "alias",
  "configures",
  "publishes",
  "subscribes",
  "ffi",
  "abi",
  "generated",
  "guarded-by",
  "trust-crossing",
] as const

const locationSchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1, maxLength: 4_096 },
    startLine: { type: "integer", minimum: 1 },
    startColumn: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    endColumn: { type: "integer", minimum: 1 },
    nodeId: { type: "string", maxLength: 128 },
    message: { type: "string", maxLength: 2_000 },
  },
  required: ["path", "startLine"],
}

const edgeKindArraySchema = {
  type: "array" as const,
  maxItems: edgeKinds.length,
  items: { type: "string" as const, enum: edgeKinds },
}

export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: "code_graph_index",
    description:
      "Incrementally index the authorized source with the embedded polyglot Code Graph. Returns snapshot identity, invalidation, reuse, exclusions, and per-file capability evidence.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        paths: {
          type: "array" as const,
          maxItems: 10_000,
          items: { type: "string" as const, minLength: 1, maxLength: 4_096 },
        },
        force: { type: "boolean" as const, default: false },
        snapshotLabel: { type: "string" as const, minLength: 1, maxLength: 200 },
      },
    },
  },
  {
    name: "code_graph_query",
    description:
      "Run one bounded symbols, neighbors, weighted path, taint, slice, or coverage query against the current local Code Graph.",
    inputSchema: {
      type: "object" as const,
      oneOf: [
        {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            kind: { const: "symbols" },
            name: { type: "string" as const, maxLength: 300 },
            file: { type: "string" as const, maxLength: 4_096 },
            nodeKind: { type: "string" as const },
            limit: { type: "integer" as const, minimum: 1, maximum: 1_000 },
          },
          required: ["kind"],
        },
        {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            kind: { const: "neighbors" },
            nodeId: { type: "string" as const, minLength: 1, maxLength: 128 },
            direction: { type: "string" as const, enum: ["forward", "backward", "both"] },
            edgeKinds: edgeKindArraySchema,
            maxDepth: { type: "integer" as const, minimum: 1, maximum: 40 },
            limit: { type: "integer" as const, minimum: 1, maximum: 2_000 },
          },
          required: ["kind", "nodeId"],
        },
        {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            kind: { const: "path" },
            fromNodeId: { type: "string" as const, minLength: 1, maxLength: 128 },
            toNodeId: { type: "string" as const, minLength: 1, maxLength: 128 },
            edgeKinds: edgeKindArraySchema,
            maxDepth: { type: "integer" as const, minimum: 1, maximum: 40 },
          },
          required: ["kind", "fromNodeId", "toNodeId"],
        },
        {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            kind: { const: "taint" },
            sourceNodeIds: {
              type: "array" as const,
              maxItems: 500,
              items: { type: "string" as const, maxLength: 128 },
            },
            sinkNodeIds: {
              type: "array" as const,
              maxItems: 500,
              items: { type: "string" as const, maxLength: 128 },
            },
            maxDepth: { type: "integer" as const, minimum: 1, maximum: 50 },
            maxPaths: { type: "integer" as const, minimum: 1, maximum: 100 },
          },
          required: ["kind"],
        },
        {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            kind: { const: "slice" },
            nodeId: { type: "string" as const, minLength: 1, maxLength: 128 },
            direction: { type: "string" as const, enum: ["forward", "backward"] },
            edgeKinds: edgeKindArraySchema,
            maxDepth: { type: "integer" as const, minimum: 1, maximum: 40 },
            limit: { type: "integer" as const, minimum: 1, maximum: 2_000 },
          },
          required: ["kind", "nodeId"],
        },
        {
          type: "object" as const,
          additionalProperties: false,
          properties: { kind: { const: "coverage" } },
          required: ["kind"],
        },
      ],
    },
  },
  {
    name: "code_finding",
    description:
      "Record, retrieve, filter, transition, or export authoritative security findings. Export format and path are fixed by the active workflow.",
    inputSchema: {
      type: "object" as const,
      oneOf: [
        {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            action: { const: "record" },
            workflow: { type: "string" as const, enum: findingWorkflows },
            title: { type: "string" as const, minLength: 1, maxLength: 300 },
            weakness: { type: "string" as const, minLength: 1, maxLength: 160 },
            severity: { type: "string" as const, enum: findingSeverities },
            confidence: { type: "string" as const, enum: ["confirmed", "high", "medium", "low"] },
            locations: { type: "array" as const, minItems: 1, maxItems: 100, items: locationSchema },
            traces: {
              type: "array" as const,
              maxItems: 100,
              items: {
                type: "object" as const,
                additionalProperties: false,
                properties: {
                  nodes: {
                    type: "array" as const,
                    maxItems: 2_000,
                    items: { type: "string" as const, maxLength: 128 },
                  },
                  edges: {
                    type: "array" as const,
                    maxItems: 2_000,
                    items: { type: "string" as const, maxLength: 128 },
                  },
                  description: { type: "string" as const, maxLength: 4_000 },
                },
                required: ["nodes", "edges"],
              },
            },
            evidence: {
              type: "array" as const,
              minItems: 1,
              maxItems: 100,
              items: {
                type: "object" as const,
                additionalProperties: false,
                properties: {
                  kind: {
                    type: "string" as const,
                    enum: ["code", "test", "configuration", "runtime", "manual"],
                  },
                  description: { type: "string" as const, minLength: 1, maxLength: 8_000 },
                  fingerprint: { type: "string" as const, maxLength: 256 },
                  location: locationSchema,
                },
                required: ["kind", "description"],
              },
            },
            remediation: { type: "string" as const, minLength: 1, maxLength: 16_000 },
            base: { type: "string" as const, maxLength: 512 },
            head: { type: "string" as const, maxLength: 512 },
            relatedFindings: {
              type: "array" as const,
              maxItems: 100,
              items: { type: "string" as const, maxLength: 128 },
            },
          },
          required: [
            "action",
            "workflow",
            "title",
            "weakness",
            "severity",
            "confidence",
            "locations",
            "evidence",
            "remediation",
          ],
        },
        {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            action: { const: "get" },
            id: { type: "string" as const, pattern: "^[a-f0-9]{64}$" },
          },
          required: ["action", "id"],
        },
        {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            action: { const: "list" },
            statuses: { type: "array" as const, maxItems: 5, items: { type: "string", enum: findingStatuses } },
            severities: {
              type: "array" as const,
              maxItems: 5,
              items: { type: "string", enum: findingSeverities },
            },
            workflows: { type: "array" as const, maxItems: 5, items: { type: "string", enum: findingWorkflows } },
            weakness: { type: "string" as const, maxLength: 160 },
            limit: { type: "integer" as const, minimum: 1, maximum: 1_000 },
          },
          required: ["action"],
        },
        {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            action: { const: "transition" },
            id: { type: "string" as const, pattern: "^[a-f0-9]{64}$" },
            status: { type: "string" as const, enum: findingStatuses },
            reason: { type: "string" as const, minLength: 1, maxLength: 4_000 },
          },
          required: ["action", "id", "status", "reason"],
        },
        {
          type: "object" as const,
          additionalProperties: false,
          properties: { action: { const: "export" } },
          required: ["action"],
        },
      ],
    },
  },
  {
    name: "code_graph_manifest",
    description:
      "Return the embedded language adapter, capability, integrity, and provenance manifest plus the selected local source kind.",
    inputSchema: { type: "object" as const, additionalProperties: false, properties: {} },
  },
] as const

export type CodeGraphToolName = (typeof CODE_GRAPH_TOOL_DEFS)[number]["name"]

type Environment = Readonly<Record<string, string | undefined>>
type ServiceFactory = typeof createCodeGraphService

export interface CodeGraphToolHandler {
  handle(name: CodeGraphToolName, args: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

export interface CodeGraphToolHandlerOptions {
  readonly environment?: Environment
  readonly serviceFactory?: ServiceFactory
}

interface ResolvedContext {
  readonly workflow: CodeGraphWorkflow
  readonly phase: string
  readonly sourceRoot: string
  readonly workareaRoot: string
  readonly sourceKind: "project-source" | "source-import" | "source-snapshot"
}

interface Runtime {
  readonly context: ResolvedContext
  readonly service: CodeGraphService
}

function workflowFrom(environment: Environment) {
  const value = environment.CYBERFUL_SUBSYSTEM_WORKFLOW?.trim()
  return CODE_GRAPH_WORKFLOWS.find((workflow) => workflow === value)
}

function configuredRoots(environment: Environment) {
  const sourceRoot = environment.CYBERFUL_SUBSYSTEM_SOURCE_ROOT?.trim()
  const workareaRoot = environment.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim()
  if (!sourceRoot || !workareaRoot || !path.isAbsolute(sourceRoot) || !path.isAbsolute(workareaRoot)) return
  return { sourceRoot: path.resolve(sourceRoot), workareaRoot: path.resolve(workareaRoot) }
}

function isContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function canonicalPlainDirectory(input: string, label: string) {
  const metadata = await lstat(input)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a plain directory`)
  return realpath(input)
}

// ── Analysis Uses The Verified Source ────────────────────────────
// The source boundary selects a verified host-owned import or snapshot before
// project source. Mutable copies inside the workarea fail closed.
// Import manifests and snapshots are revalidated before a SQLite service opens,
// so no graph state is created for an ambiguous or unauthenticated source.
//
// ─────────────────────────────────────────────────────────────────

async function resolveContext(environment: Environment): Promise<ResolvedContext> {
  const workflow = workflowFrom(environment)
  const phase = environment.CYBERFUL_SUBSYSTEM_PHASE?.trim()
  const roots = configuredRoots(environment)
  if (!workflow || !phase || !roots)
    throw new Error("Code Graph tools require an active Code Audit phase and absolute source/workarea roots")
  const sourceRoot = await canonicalPlainDirectory(roots.sourceRoot, "Code Graph source root")
  const workareaRoot = await canonicalPlainDirectory(roots.workareaRoot, "Code Graph workarea root")
  const effective = await resolveEffectiveSource(sourceRoot, workareaRoot, environment)
  return { workflow, phase, sourceRoot: effective.root, workareaRoot, sourceKind: effective.kind }
}

interface FindingAttestationPayload {
  readonly version: 2
  readonly finding_id: string
  readonly status: SecurityFinding["status"]
  readonly finding_sha256: string
  readonly transitions_sha256: string
  readonly transition_count: number
}

interface FindingAttestation extends FindingAttestationPayload {
  readonly hmac_sha256: string
}

function ledgerKey(environment: Environment) {
  const key = environment.CYBERFUL_CODE_GRAPH_LEDGER_KEY?.trim()
  if (!key || Buffer.byteLength(key) < 32) throw new Error("Code Graph finding attestation is unavailable")
  return key
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) throw new Error("Finding contains a non-canonical value")
  const record = value
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .toSorted()
      .map((key) => [key, canonicalValue(record[key])]),
  )
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value))
}

function transitionsForFinding(
  transitions: readonly FindingTransitionRecord[],
  findingId: string,
): readonly FindingTransitionRecord[] {
  return transitions
    .filter((transition) => transition.findingId === findingId)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
}

function attestationPayload(
  finding: SecurityFinding,
  transitions: readonly FindingTransitionRecord[],
): FindingAttestationPayload {
  const history = transitionsForFinding(transitions, finding.id)
  return {
    version: 2,
    finding_id: finding.id,
    status: finding.status,
    finding_sha256: createHash("sha256").update(canonicalJson(finding)).digest("hex"),
    transitions_sha256: createHash("sha256").update(canonicalJson(history)).digest("hex"),
    transition_count: history.length,
  }
}

function findingHmac(payload: FindingAttestationPayload, key: string) {
  return createHmac("sha256", key).update(canonicalJson(payload)).digest("hex")
}

interface CodeGraphReadinessPayload {
  readonly version: 1
  readonly full_inventory: true
  readonly workflow: CodeGraphWorkflow
  readonly source_kind: ResolvedContext["sourceKind"]
  readonly snapshot_id: string
  readonly snapshot_fingerprint: string
  readonly coverage_sha256: string
  readonly coverage_entries: number
}

interface CodeGraphReadinessAttestation extends CodeGraphReadinessPayload {
  readonly hmac_sha256: string
}

function readinessHmac(payload: CodeGraphReadinessPayload, key: string) {
  return createHmac("sha256", key).update(canonicalJson(payload)).digest("hex")
}

function currentReadinessPayload(context: ResolvedContext, service: CodeGraphService): CodeGraphReadinessPayload {
  const state = service.readinessState()
  const snapshot = state.snapshot
  if (!snapshot) throw new Error("Code Graph readiness requires a committed graph snapshot")
  if (snapshot.root !== service.sourceRoot)
    throw new Error("Code Graph snapshot does not describe the preflighted source root")
  if (state.coverage.length === 0) throw new Error("Code Graph readiness requires non-empty coverage")
  return {
    version: 1,
    full_inventory: true,
    workflow: context.workflow,
    source_kind: context.sourceKind,
    snapshot_id: snapshot.id,
    snapshot_fingerprint: snapshot.fingerprint,
    coverage_sha256: createHash("sha256").update(canonicalJson(state.coverage)).digest("hex"),
    coverage_entries: state.coverage.length,
  }
}

function readinessPath(context: ResolvedContext) {
  return path.join(context.workareaRoot, "raw", "code-graph", "readiness.json")
}

async function writeCodeGraphReadiness(context: ResolvedContext, service: CodeGraphService, key: string) {
  await ensurePlainDirectory(context.workareaRoot, "raw/code-graph")
  const payload = currentReadinessPayload(context, service)
  const value: CodeGraphReadinessAttestation = { ...payload, hmac_sha256: readinessHmac(payload, key) }
  const destination = readinessPath(context)
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
  const handle = await open(temporary, flags, 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" })
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (process.platform === "win32") await rm(destination, { force: true })
    await rename(temporary, destination)
    if (process.platform !== "win32") await chmod(destination, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

function parseCodeGraphReadiness(value: unknown): CodeGraphReadinessAttestation | undefined {
  if (!isRecord(value)) return
  const workflow = CODE_GRAPH_WORKFLOWS.find((candidate) => candidate === value.workflow)
  const sourceKind = ["project-source", "source-import", "source-snapshot"].find(
    (candidate) => candidate === value.source_kind,
  ) as ResolvedContext["sourceKind"] | undefined
  if (
    value.version !== 1 ||
    value.full_inventory !== true ||
    !workflow ||
    !sourceKind ||
    typeof value.snapshot_id !== "string" ||
    !value.snapshot_id ||
    typeof value.snapshot_fingerprint !== "string" ||
    !value.snapshot_fingerprint ||
    typeof value.coverage_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.coverage_sha256) ||
    !Number.isSafeInteger(value.coverage_entries) ||
    Number(value.coverage_entries) <= 0 ||
    typeof value.hmac_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.hmac_sha256)
  )
    return
  return {
    version: 1,
    full_inventory: true,
    workflow,
    source_kind: sourceKind,
    snapshot_id: value.snapshot_id,
    snapshot_fingerprint: value.snapshot_fingerprint,
    coverage_sha256: value.coverage_sha256,
    coverage_entries: Number(value.coverage_entries),
    hmac_sha256: value.hmac_sha256,
  }
}

function equalHmac(expected: string, actual: string) {
  const expectedBytes = Buffer.from(expected, "hex")
  const actualBytes = Buffer.from(actual, "hex")
  return expectedBytes.byteLength === actualBytes.byteLength && timingSafeEqual(expectedBytes, actualBytes)
}

export async function verifyCodeGraphReadiness(environment: Environment = process.env) {
  const context = await resolveContext(environment)
  const key = ledgerKey(environment)
  const service = await createCodeGraphService({ sourceRoot: context.sourceRoot, workareaRoot: context.workareaRoot })
  try {
    const destination = readinessPath(context)
    const metadata = await lstat(destination)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024)
      throw new Error("Code Graph readiness attestation is missing or unsafe")
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(destination, "utf8"))
    } catch {
      throw new Error("Code Graph readiness attestation is not valid JSON")
    }
    const recorded = parseCodeGraphReadiness(parsed)
    if (!recorded) throw new Error("Code Graph readiness attestation is malformed")
    const { hmac_sha256: hmac, ...recordedPayload } = recorded
    if (!equalHmac(readinessHmac(recordedPayload, key), hmac))
      throw new Error("Code Graph readiness attestation does not match")
    const current = currentReadinessPayload(context, service)
    if (canonicalJson(recordedPayload) !== canonicalJson(current))
      throw new Error("Code Graph snapshot or coverage changed after readiness was attested")
    return current
  } finally {
    await service.close()
  }
}

async function ensurePlainDirectory(root: string, relative: string) {
  let current = root
  for (const segment of relative.split("/").filter(Boolean)) {
    current = path.join(current, segment)
    let metadata
    try {
      metadata = await lstat(current)
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error
      await mkdir(current, { mode: 0o700 })
      metadata = await lstat(current)
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("Code Graph attestation path contains a non-directory or symlink")
    const canonical = await realpath(current)
    if (!isContained(root, canonical)) throw new Error("Code Graph attestation path escapes the workarea")
    current = canonical
  }
  return current
}

async function attestationFile(context: ResolvedContext, findingId: string) {
  if (!/^[a-f0-9]{64}$/.test(findingId)) throw new Error("Finding id is not a SHA-256 identifier")
  const directory = await ensurePlainDirectory(context.workareaRoot, "raw/code-graph/attestations")
  return path.join(directory, `${findingId}.json`)
}

async function writeFindingAttestation(
  context: ResolvedContext,
  finding: SecurityFinding,
  transitions: readonly FindingTransitionRecord[],
  key: string,
) {
  const payload = attestationPayload(finding, transitions)
  const value: FindingAttestation = { ...payload, hmac_sha256: findingHmac(payload, key) }
  const destination = await attestationFile(context, finding.id)
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
  const handle = await open(temporary, flags, 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" })
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (process.platform === "win32") await rm(destination, { force: true })
    await rename(temporary, destination)
    if (process.platform !== "win32") await chmod(destination, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

function parseAttestation(value: unknown): FindingAttestation | undefined {
  if (!isRecord(value)) return
  const input = value
  if (
    input.version !== 2 ||
    typeof input.finding_id !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.finding_id) ||
    !isFindingStatus(input.status) ||
    typeof input.finding_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.finding_sha256) ||
    typeof input.transitions_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.transitions_sha256) ||
    !Number.isSafeInteger(input.transition_count) ||
    Number(input.transition_count) < 0 ||
    typeof input.hmac_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.hmac_sha256)
  )
    return
  return {
    version: 2,
    finding_id: input.finding_id,
    status: input.status,
    finding_sha256: input.finding_sha256,
    transitions_sha256: input.transitions_sha256,
    transition_count: Number(input.transition_count),
    hmac_sha256: input.hmac_sha256,
  }
}

async function readFindingAttestation(context: ResolvedContext, findingId: string) {
  const file = await attestationFile(context, findingId)
  const metadata = await lstat(file)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024)
    throw new Error("Finding attestation is not a bounded plain file")
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
  const handle = await open(file, flags)
  try {
    const value: unknown = JSON.parse(await handle.readFile({ encoding: "utf8" }))
    return parseAttestation(value)
  } finally {
    await handle.close()
  }
}

async function findingIsAttested(
  context: ResolvedContext,
  finding: SecurityFinding,
  transitions: readonly FindingTransitionRecord[],
  key: string,
) {
  const recorded = await readFindingAttestation(context, finding.id)
  if (!recorded) return false
  const payload = attestationPayload(finding, transitions)
  if (
    recorded.finding_id !== payload.finding_id ||
    recorded.status !== payload.status ||
    recorded.finding_sha256 !== payload.finding_sha256 ||
    recorded.transitions_sha256 !== payload.transitions_sha256 ||
    recorded.transition_count !== payload.transition_count
  )
    return false
  const expected = Buffer.from(findingHmac(payload, key), "hex")
  const actual = Buffer.from(recorded.hmac_sha256, "hex")
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual)
}

function findingAction(args: Record<string, unknown>) {
  if (typeof args.action !== "string") throw new Error("code_finding requires an action")
  return args.action
}

function findingPayload(args: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(args).filter(([key]) => key !== "action"))
}

function assertExportHasNoCallerPath(args: Record<string, unknown>) {
  const unexpected = Object.keys(args).filter((key) => key !== "action")
  if (unexpected.length > 0) throw new Error("code_finding export path and format are fixed by the active workflow")
}

async function assertAttestedFindingIntegrity(runtime: Runtime, environment: Environment) {
  const integrity = runtime.service.findingIntegrityState()
  const findingIds = new Set(integrity.findings.map((finding) => finding.id))
  const orphan = integrity.transitions.find((transition) => !findingIds.has(transition.findingId))
  if (orphan) throw new Error(`Code Graph transition ${orphan.id} has no attested finding`)
  const key = ledgerKey(environment)
  for (const finding of integrity.findings) {
    if (!(await findingIsAttested(runtime.context, finding, integrity.transitions, key)))
      throw new Error(`Code Graph finding ${finding.id} or its transition history failed host attestation`)
  }
  return integrity
}

async function exportFindings(runtime: Runtime, integrity: FindingIntegrityState) {
  const result = async (
    format: "sarif" | "evidence",
    exported: Promise<{ path: string; sha256: string; bytes: number }>,
  ) => {
    const completed = await exported
    if (!isContained(runtime.context.workareaRoot, completed.path))
      throw new Error("Code Graph export escaped the canonical workarea")
    return {
      format,
      ...completed,
      path: path.relative(runtime.context.workareaRoot, completed.path).replaceAll(path.sep, "/"),
    }
  }
  const exports = [
    await result("sarif", runtime.service.exportSarif("reports/code-audit.sarif", integrity)),
    await result("evidence", runtime.service.exportEvidence("reports/code-audit-evidence.json", integrity)),
  ]
  return { workflow: runtime.context.workflow, exports }
}

export function codeGraphToolsAvailable(environment: Environment = process.env) {
  return workflowFrom(environment) !== undefined && configuredRoots(environment) !== undefined
}

export function isCodeGraphTool(name: string): name is CodeGraphToolName {
  return CODE_GRAPH_TOOL_DEFS.some((tool) => tool.name === name)
}

// ── Lazy Creation Has One Explicit Gateway Owner ─────────────────
// Listing tools does not create SQLite state. The first actual operation
// resolves canonical roots and creates exactly one service shared by graph and
// finding calls in that gateway. Concurrent first calls share the same promise;
// close waits for in-flight creation/indexing and is idempotent. A gateway may
// therefore wire cleanup directly without relying on mutable module globals.
//
// ─────────────────────────────────────────────────────────────────

export function createCodeGraphToolHandler(options: CodeGraphToolHandlerOptions = {}): CodeGraphToolHandler {
  const environment = options.environment ?? process.env
  const serviceFactory = options.serviceFactory ?? createCodeGraphService
  let runtimePromise: Promise<Runtime> | undefined
  let mutationTail: Promise<void> = Promise.resolve()
  let closed = false

  const runtime = async () => {
    if (closed) throw new Error("Code Graph tool handler is closed")
    runtimePromise ??= resolveContext(environment)
      .then(async (context) => ({
        context,
        service: await serviceFactory({ sourceRoot: context.sourceRoot, workareaRoot: context.workareaRoot }),
      }))
      .catch((error: unknown) => {
        runtimePromise = undefined
        throw error
      })
    const active = await runtimePromise
    if (!closed) return active
    await active.service.close()
    throw new Error("Code Graph tool handler is closed")
  }

  const mutate = <T>(operation: () => Promise<T>) => {
    const result = mutationTail.then(operation, operation)
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  return {
    async handle(name, args) {
      const active = await runtime()
      switch (name) {
        case "code_graph_index":
          await rm(readinessPath(active.context), { force: true })
          return active.service.index(args).then(async (report) => {
            if (args.paths === undefined)
              await writeCodeGraphReadiness(active.context, active.service, ledgerKey(environment))
            return report
          })
        case "code_graph_query":
          return active.service.query(args)
        case "code_graph_manifest":
          if (Object.keys(args).length > 0) throw new Error("code_graph_manifest accepts no arguments")
          return {
            source: active.context.sourceKind,
            database_path: "raw/code-graph/index.sqlite",
            ...active.service.languageManifest(),
          }
        case "code_finding": {
          switch (findingAction(args)) {
            case "record":
              if (active.context.phase !== "hunt" && active.context.phase !== "attack")
                throw new Error("Only Code Audit Hunt and Attack may record suspected candidates")
              if (args.workflow !== active.context.workflow)
                throw new Error(`code_finding workflow must match the active ${active.context.workflow} workflow`)
              if (args.status !== undefined) throw new Error("New Code Graph findings always start as suspected")
              return mutate(async () => {
                const key = ledgerKey(environment)
                const input = parseSecurityFindingInput(findingPayload(args))
                const existing = active.service.getFinding(findingIdentity(input))
                if (existing?.status === "confirmed")
                  throw new Error("A confirmed finding cannot be changed by a new candidate record")
                const finding = active.service.recordFinding(input)
                await writeFindingAttestation(
                  active.context,
                  finding,
                  active.service.findingIntegrityState().transitions,
                  key,
                )
                return finding
              })
            case "get":
              return active.service.getFinding(args.id) ?? { error: "finding not found" }
            case "list":
              return active.service.listFindings(findingPayload(args))
            case "transition":
              return mutate(async () => {
                if (active.context.phase !== "verify")
                  throw new Error("Only Code Audit Verify may transition candidate dispositions")
                const key = ledgerKey(environment)
                const finding = active.service.transitionFinding({
                  id: args.id,
                  status: args.status,
                  reason: args.reason,
                })
                await writeFindingAttestation(
                  active.context,
                  finding,
                  active.service.findingIntegrityState().transitions,
                  key,
                )
                return finding
              })
            case "export":
              if (active.context.phase !== "report") throw new Error("Only Code Audit Report may export findings")
              assertExportHasNoCallerPath(args)
              return exportFindings(active, await assertAttestedFindingIntegrity(active, environment))
            default:
              throw new Error(`Unsupported code_finding action: ${String(args.action)}`)
          }
        }
      }
    },
    async close() {
      if (closed) return
      closed = true
      await mutationTail
      const pending = runtimePromise
      runtimePromise = undefined
      if (!pending) return
      const active = await pending
      await active.service.close()
    },
  }
}
