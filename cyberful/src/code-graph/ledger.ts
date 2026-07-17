// ── Security Finding Ledger And Host Exports ────────────────────────────────
// Validates findings once at the host boundary, assigns stable identities,
// enforces auditable status transitions, and renders SARIF/evidence from the
// durable ledger. Model-authored free-form JSON never becomes an authoritative
// report without passing these structural and lifecycle checks.
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path"
import {
  findingConfidences,
  findingWorkflows,
  findingSeverities,
  findingStatuses,
  type EvidenceExport,
  type FindingConfidence,
  type FindingEvidence,
  type FindingFilter,
  type FindingLocation,
  type FindingSeverity,
  type FindingStatus,
  type FindingTrace,
  type FindingTransition,
  type FindingTransitionRecord,
  type SarifExport,
  type SecurityFinding,
  type SecurityFindingInput,
} from "./types"
import { CodeGraphStore, findingIdentity, transitionIdentity } from "./store"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function object(value: unknown, label: string) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`)
  return value
}

function text(value: unknown, label: string, maximum = 8_000) {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) throw new Error(`${label} must contain 1-${maximum} characters.`)
  return normalized
}

function optionalText(value: unknown, label: string, maximum = 8_000) {
  if (value === undefined) return
  return text(value, label, maximum)
}

function integer(value: unknown, label: string, minimum = 1) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${label} must be an integer >= ${minimum}.`)
  return value
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  const match = typeof value === "string" ? values.find((candidate) => candidate === value) : undefined
  if (match === undefined) throw new Error(`${label} has an unsupported value.`)
  return match
}

function relativeFile(value: unknown, label: string) {
  const candidate = text(value, label, 4_096).replaceAll("\\", "/")
  if (path.posix.isAbsolute(candidate) || candidate.split("/").includes(".."))
    throw new Error(`${label} must stay relative to the source root.`)
  return candidate.replace(/^\.\//, "")
}

function array<T>(value: unknown, label: string, convert: (item: unknown, index: number) => T, maximum = 1_000) {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error(`${label} must be an array with at most ${maximum} items.`)
  return value.map(convert)
}

function location(value: unknown, label: string): FindingLocation {
  const input = object(value, label)
  const startLine = integer(input.startLine, `${label}.startLine`)
  const endLine = input.endLine === undefined ? undefined : integer(input.endLine, `${label}.endLine`)
  if (endLine !== undefined && endLine < startLine) throw new Error(`${label}.endLine cannot precede startLine.`)
  return {
    path: relativeFile(input.path, `${label}.path`),
    startLine,
    startColumn: input.startColumn === undefined ? undefined : integer(input.startColumn, `${label}.startColumn`),
    endLine,
    endColumn: input.endColumn === undefined ? undefined : integer(input.endColumn, `${label}.endColumn`),
    nodeId: optionalText(input.nodeId, `${label}.nodeId`, 128),
    message: optionalText(input.message, `${label}.message`, 2_000),
  }
}

function trace(value: unknown, label: string): FindingTrace {
  const input = object(value, label)
  return {
    nodes: array(input.nodes, `${label}.nodes`, (item, index) => text(item, `${label}.nodes[${index}]`, 128), 2_000),
    edges: array(input.edges, `${label}.edges`, (item, index) => text(item, `${label}.edges[${index}]`, 128), 2_000),
    description: optionalText(input.description, `${label}.description`, 4_000),
  }
}

function evidence(value: unknown, label: string): FindingEvidence {
  const input = object(value, label)
  return {
    kind: oneOf(input.kind, ["code", "test", "configuration", "runtime", "manual"] as const, `${label}.kind`),
    description: text(input.description, `${label}.description`, 8_000),
    fingerprint: optionalText(input.fingerprint, `${label}.fingerprint`, 256),
    location: input.location === undefined ? undefined : location(input.location, `${label}.location`),
  }
}

export function parseSecurityFindingInput(value: unknown): SecurityFindingInput {
  const input = object(value, "finding")
  const locations = array(
    input.locations,
    "finding.locations",
    (item, index) => location(item, `finding.locations[${index}]`),
    100,
  )
  if (locations.length === 0) throw new Error("finding.locations must contain at least one location.")
  const evidenceItems = array(
    input.evidence,
    "finding.evidence",
    (item, index) => evidence(item, `finding.evidence[${index}]`),
    100,
  )
  if (evidenceItems.length === 0) throw new Error("finding.evidence must contain at least one evidence item.")
  return {
    workflow: oneOf(input.workflow, findingWorkflows, "finding.workflow"),
    title: text(input.title, "finding.title", 300),
    weakness: text(input.weakness, "finding.weakness", 160),
    severity: oneOf(input.severity, findingSeverities, "finding.severity"),
    confidence: oneOf(input.confidence, findingConfidences, "finding.confidence"),
    status: input.status === undefined ? undefined : oneOf(input.status, findingStatuses, "finding.status"),
    locations,
    traces:
      input.traces === undefined
        ? undefined
        : array(input.traces, "finding.traces", (item, index) => trace(item, `finding.traces[${index}]`), 100),
    evidence: evidenceItems,
    remediation: text(input.remediation, "finding.remediation", 16_000),
    base: optionalText(input.base, "finding.base", 512),
    head: optionalText(input.head, "finding.head", 512),
    relatedFindings:
      input.relatedFindings === undefined
        ? undefined
        : array(
            input.relatedFindings,
            "finding.relatedFindings",
            (item, index) => text(item, `finding.relatedFindings[${index}]`, 128),
            100,
          ),
  }
}

export function parseFindingFilter(value: unknown): FindingFilter {
  if (value === undefined) return {}
  const input = object(value, "finding filter")
  return {
    statuses:
      input.statuses === undefined
        ? undefined
        : array(input.statuses, "finding filter.statuses", (item) => oneOf(item, findingStatuses, "finding status"), 5),
    severities:
      input.severities === undefined
        ? undefined
        : array(
            input.severities,
            "finding filter.severities",
            (item) => oneOf(item, findingSeverities, "finding severity"),
            5,
          ),
    workflows:
      input.workflows === undefined
        ? undefined
        : array(
            input.workflows,
            "finding filter.workflows",
            (item) => oneOf(item, findingWorkflows, "finding workflow"),
            5,
          ),
    weakness: optionalText(input.weakness, "finding filter.weakness", 160),
    limit: input.limit === undefined ? undefined : Math.min(1_000, integer(input.limit, "finding filter.limit")),
  }
}

export function parseFindingTransition(value: unknown): FindingTransition {
  const input = object(value, "finding transition")
  return {
    id: text(input.id, "finding transition.id", 128),
    status: oneOf(input.status, findingStatuses, "finding transition.status"),
    reason: text(input.reason, "finding transition.reason", 4_000),
  }
}

const allowedTransitions: Readonly<Record<FindingStatus, readonly FindingStatus[]>> = {
  suspected: ["confirmed", "dismissed"],
  confirmed: ["fixed", "residual", "dismissed"],
  dismissed: ["suspected"],
  fixed: ["residual"],
  residual: ["confirmed", "fixed", "dismissed"],
}

function resultLevel(severity: FindingSeverity): "error" | "warning" | "note" {
  if (severity === "critical" || severity === "high") return "error"
  if (severity === "medium" || severity === "low") return "warning"
  return "note"
}

function precision(confidence: FindingConfidence): "very-high" | "high" | "medium" | "low" {
  if (confidence === "confirmed") return "very-high"
  return confidence
}

// ── Status Changes Require An Explicit Audit Trail ─────────────────────────
// Recording the same root cause enriches its evidence without resetting a
// verifier's decision. Lifecycle changes instead use a constrained state
// machine and an immutable reasoned transition. This prevents a repeated model
// proposal from silently reviving, dismissing, or fixing an authoritative
// finding and preserves remediation provenance for later assessment.
// ─────────────────────────────────────────────────────────────────────────────

export class FindingLedger {
  readonly #store: CodeGraphStore
  readonly #now: () => Date

  constructor(store: CodeGraphStore, now: () => Date = () => new Date()) {
    this.#store = store
    this.#now = now
  }

  record(value: unknown) {
    const input = parseSecurityFindingInput(value)
    const id = findingIdentity(input)
    const previous = this.#store.finding(id)
    const timestamp = this.#now().toISOString()
    const finding: SecurityFinding = {
      ...input,
      id,
      status: previous?.status ?? "suspected",
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }
    this.#store.upsertFinding(finding)
    return this.#store.finding(id) ?? finding
  }

  list(value?: unknown) {
    const filter = parseFindingFilter(value)
    const weakness = filter.weakness?.toLowerCase()
    return this.#store
      .findings()
      .filter((finding) => !filter.statuses || filter.statuses.includes(finding.status))
      .filter((finding) => !filter.severities || filter.severities.includes(finding.severity))
      .filter((finding) => !filter.workflows || filter.workflows.includes(finding.workflow))
      .filter((finding) => !weakness || finding.weakness.toLowerCase().includes(weakness))
      .slice(0, filter.limit ?? 200)
  }

  transition(value: unknown) {
    const input = parseFindingTransition(value)
    const finding = this.#store.finding(input.id)
    if (!finding) throw new Error(`Finding ${input.id} does not exist.`)
    if (finding.status === input.status) return finding
    if (!allowedTransitions[finding.status].includes(input.status))
      throw new Error(`Finding cannot transition from ${finding.status} to ${input.status}.`)
    const timestamp = this.#now().toISOString()
    this.#store.transition({
      expected: finding.status,
      record: {
        id: transitionIdentity(finding.id, finding.status, input.status, input.reason, timestamp),
        findingId: finding.id,
        fromStatus: finding.status,
        toStatus: input.status,
        reason: input.reason,
        createdAt: timestamp,
      },
    })
    const updated = this.#store.finding(finding.id)
    if (!updated) throw new Error(`Finding ${finding.id} disappeared after its status transition.`)
    return updated
  }

  sarif(sourceFindings: readonly SecurityFinding[] = this.#store.findings()): SarifExport {
    const findings = sourceFindings.filter(
      (finding) => finding.status === "confirmed" || finding.status === "fixed" || finding.status === "residual",
    )
    const weaknesses = [...new Set(findings.map((finding) => finding.weakness))].toSorted()
    const rules = weaknesses.map((weakness) => ({
      id: weakness,
      name: weakness.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "SecurityFinding",
      shortDescription: { text: weakness },
      helpUri: /^CWE-\d+$/i.test(weakness)
        ? `https://cwe.mitre.org/data/definitions/${weakness.replace(/\D/g, "")}.html`
        : undefined,
      properties: { tags: ["security"] },
    }))
    const results = findings.map((finding) => ({
      ruleId: finding.weakness,
      level: resultLevel(finding.severity),
      message: { text: `${finding.title}\n\n${finding.remediation}` },
      locations: finding.locations.map((item) => ({
        physicalLocation: {
          artifactLocation: { uri: item.path.replaceAll("\\", "/"), uriBaseId: "%SRCROOT%" },
          region: {
            startLine: item.startLine,
            startColumn: item.startColumn,
            endLine: item.endLine,
            endColumn: item.endColumn,
          },
        },
        message: item.message ? { text: item.message } : undefined,
      })),
      codeFlows: (finding.traces ?? []).map((item) => ({
        message: item.description ? { text: item.description } : undefined,
        threadFlows: [
          {
            locations: item.nodes.flatMap((nodeId) => {
              const node = this.#store.nodes().find((candidate) => candidate.id === nodeId)
              if (!node) return []
              return [
                {
                  location: {
                    physicalLocation: {
                      artifactLocation: { uri: node.file, uriBaseId: "%SRCROOT%" },
                      region: { startLine: node.line, startColumn: node.column, endLine: node.endLine },
                    },
                  },
                },
              ]
            }),
          },
        ],
      })),
      partialFingerprints: { cyberfulFindingId: finding.id },
      properties: {
        severity: finding.severity,
        confidence: finding.confidence,
        precision: precision(finding.confidence),
        status: finding.status,
        workflow: finding.workflow,
        evidence: finding.evidence,
        base: finding.base,
        head: finding.head,
      },
    }))
    return {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "Cyberful Code Graph",
              informationUri: "https://github.com/cyberful/cyberful",
              semanticVersion: "1.0.0",
              rules,
            },
          },
          originalUriBaseIds: { "%SRCROOT%": { uri: "file:///" } },
          results,
        },
      ],
    }
  }

  evidence(integrity?: {
    readonly findings: readonly SecurityFinding[]
    readonly transitions: readonly FindingTransitionRecord[]
  }): EvidenceExport {
    const snapshot = this.#store.latestSnapshot()
    return {
      schemaVersion: "1.0",
      generatedAt: this.#now().toISOString(),
      snapshot: snapshot ? { id: snapshot.id, fingerprint: snapshot.fingerprint, root: snapshot.root } : undefined,
      coverage: this.#store.coverage(),
      findings: integrity?.findings ?? this.#store.findings(),
      transitions: integrity?.transitions ?? this.#store.transitions(),
    }
  }
}
