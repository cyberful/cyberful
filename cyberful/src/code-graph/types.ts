// ── Code Graph Public Contracts ─────────────────────────────────────────────
// Defines the validated, JSON-serializable boundary shared by language
// adapters, the incremental graph engine, gateway tools, and report exporters.
// The contracts make analysis fidelity and incomplete coverage visible instead
// of allowing a caller to infer guarantees from a language name alone.
// ─────────────────────────────────────────────────────────────────────────────

export const languageDomains = [
  "application",
  "systems",
  "crypto",
  "smart-contract",
  "robotics",
  "firmware",
  "hardware",
  "infrastructure",
  "data",
] as const

export type LanguageDomain = (typeof languageDomains)[number]

export const capabilityLevels = ["exact", "heuristic", "structural", "unsupported"] as const
export type CapabilityLevel = (typeof capabilityLevels)[number]

export interface AdapterCapability {
  readonly level: CapabilityLevel
  readonly detail: string
}

export interface LanguageCapabilities {
  readonly parsing: AdapterCapability
  readonly symbols: AdapterCapability
  readonly controlFlow: AdapterCapability
  readonly callGraph: AdapterCapability
  readonly dataFlow: AdapterCapability
  readonly aliasing: AdapterCapability
  readonly summaries: AdapterCapability
  readonly securitySemantics: AdapterCapability
  readonly crossLanguage: AdapterCapability
}

export const graphNodeKinds = [
  "file",
  "module",
  "namespace",
  "class",
  "interface",
  "function",
  "method",
  "constructor",
  "block",
  "statement",
  "variable",
  "parameter",
  "resource",
  "endpoint",
  "topic",
  "signal",
  "register",
  "external",
] as const

export type GraphNodeKind = (typeof graphNodeKinds)[number]

export const graphEdgeKinds = [
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

export type GraphEdgeKind = (typeof graphEdgeKinds)[number]

export const securityTags = [
  "source",
  "sink",
  "guard",
  "sanitizer",
  "secret",
  "crypto",
  "memory-unsafe",
  "external-call",
  "privileged",
  "sensor",
  "actuator",
  "hardware-boundary",
] as const

export type SecurityTag = (typeof securityTags)[number]

export type GraphAttribute = string | number | boolean

export interface AdapterNode {
  readonly key: string
  readonly kind: GraphNodeKind
  readonly name: string
  readonly line: number
  readonly column: number
  readonly endLine: number
  readonly tags: readonly SecurityTag[]
  readonly attributes?: Readonly<Record<string, GraphAttribute>>
}

export interface AdapterEdge {
  readonly source: string
  readonly target: string
  readonly kind: GraphEdgeKind
  readonly weight: number
  readonly evidence?: string
}

export interface AdapterReference {
  readonly from: string
  readonly targetName: string
  readonly kind: Extract<
    GraphEdgeKind,
    | "call"
    | "import"
    | "inherits"
    | "implements"
    | "ffi"
    | "abi"
    | "generated"
    | "publishes"
    | "subscribes"
    | "configures"
  >
  readonly line: number
  readonly targetLanguage?: string
  readonly evidence?: string
}

export interface AnalysisCoverage {
  readonly parser: "grammar" | "semantic-lexer" | "declarative" | "unavailable"
  readonly confidence: number
  readonly capabilities: LanguageCapabilities
  readonly limitations: readonly string[]
}

export interface AdapterAnalysis {
  readonly nodes: readonly AdapterNode[]
  readonly edges: readonly AdapterEdge[]
  readonly references: readonly AdapterReference[]
  readonly coverage: AnalysisCoverage
  readonly diagnostics: readonly string[]
}

export interface AdapterAnalyzeInput {
  readonly path: string
  readonly content: string
  readonly contentHash: string
}

export interface LanguageAdapter {
  readonly id: string
  readonly displayName: string
  readonly version: string
  readonly implementation: {
    readonly version: string
    readonly digest: string
  }
  readonly domains: readonly LanguageDomain[]
  readonly extensions: readonly string[]
  readonly filenames: readonly string[]
  readonly capabilities: LanguageCapabilities
  readonly declarative: boolean
  supports(input: { readonly path: string; readonly contentPrefix: string }): number
  analyze(input: AdapterAnalyzeInput): AdapterAnalysis
}

export interface GraphNode {
  readonly id: string
  readonly file: string
  readonly language: string
  readonly kind: GraphNodeKind
  readonly name: string
  readonly line: number
  readonly column: number
  readonly endLine: number
  readonly tags: readonly SecurityTag[]
  readonly attributes: Readonly<Record<string, GraphAttribute>>
}

export interface GraphEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly sourceFile: string
  readonly targetFile: string
  readonly kind: GraphEdgeKind
  readonly weight: number
  readonly evidence?: string
  readonly interprocedural: boolean
}

export interface GraphPath {
  readonly nodes: readonly string[]
  readonly edges: readonly string[]
  readonly weight: number
}

export interface FileCoverage {
  readonly path: string
  readonly language: string
  readonly contentHash: string
  readonly status: "indexed" | "degraded" | "excluded" | "unsupported" | "error"
  readonly coverage: AnalysisCoverage
  readonly diagnostics: readonly string[]
}

export interface IndexOptions {
  readonly paths?: readonly string[]
  readonly force?: boolean
  readonly snapshotLabel?: string
  readonly signal?: AbortSignal
}

export interface IndexReport {
  readonly snapshotId: string
  readonly fingerprint: string
  readonly discovered: number
  readonly indexed: number
  readonly reused: number
  readonly invalidated: readonly string[]
  readonly removed: readonly string[]
  readonly unsupported: readonly string[]
  readonly diagnostics: readonly { readonly path: string; readonly messages: readonly string[] }[]
  readonly coverage: readonly FileCoverage[]
}

export type GraphQuery =
  | {
      readonly kind: "symbols"
      readonly name?: string
      readonly file?: string
      readonly nodeKind?: GraphNodeKind
      readonly limit?: number
    }
  | {
      readonly kind: "neighbors"
      readonly nodeId: string
      readonly direction?: "forward" | "backward" | "both"
      readonly edgeKinds?: readonly GraphEdgeKind[]
      readonly maxDepth?: number
      readonly limit?: number
    }
  | {
      readonly kind: "path"
      readonly fromNodeId: string
      readonly toNodeId: string
      readonly edgeKinds?: readonly GraphEdgeKind[]
      readonly maxDepth?: number
    }
  | {
      readonly kind: "taint"
      readonly sourceNodeIds?: readonly string[]
      readonly sinkNodeIds?: readonly string[]
      readonly maxDepth?: number
      readonly maxPaths?: number
    }
  | {
      readonly kind: "slice"
      readonly nodeId: string
      readonly direction?: "forward" | "backward"
      readonly edgeKinds?: readonly GraphEdgeKind[]
      readonly maxDepth?: number
      readonly limit?: number
    }
  | { readonly kind: "coverage" }

export interface GraphQueryResult {
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  readonly paths: readonly GraphPath[]
  readonly coverage: readonly FileCoverage[]
  readonly truncated: boolean
}

export const findingSeverities = ["critical", "high", "medium", "low", "info"] as const
export type FindingSeverity = (typeof findingSeverities)[number]

export const findingConfidences = ["confirmed", "high", "medium", "low"] as const
export type FindingConfidence = (typeof findingConfidences)[number]

export const findingStatuses = ["suspected", "confirmed", "dismissed"] as const
export type FindingStatus = (typeof findingStatuses)[number]

export const findingWorkflows = ["code-audit"] as const
export type FindingWorkflow = (typeof findingWorkflows)[number]

export interface FindingLocation {
  readonly path: string
  readonly startLine: number
  readonly startColumn?: number
  readonly endLine?: number
  readonly endColumn?: number
  readonly nodeId?: string
  readonly message?: string
}

export interface FindingTrace {
  readonly nodes: readonly string[]
  readonly edges: readonly string[]
  readonly description?: string
}

export interface FindingEvidence {
  readonly kind: "code" | "test" | "configuration" | "runtime" | "manual"
  readonly description: string
  readonly fingerprint?: string
  readonly location?: FindingLocation
}

export interface SecurityFindingInput {
  readonly workflow: FindingWorkflow
  readonly title: string
  readonly weakness: string
  readonly severity: FindingSeverity
  readonly confidence: FindingConfidence
  readonly status?: FindingStatus
  readonly locations: readonly FindingLocation[]
  readonly traces?: readonly FindingTrace[]
  readonly evidence: readonly FindingEvidence[]
  readonly remediation: string
  readonly base?: string
  readonly head?: string
  readonly relatedFindings?: readonly string[]
}

export interface SecurityFinding extends SecurityFindingInput {
  readonly id: string
  readonly status: FindingStatus
  readonly createdAt: string
  readonly updatedAt: string
}

export interface FindingFilter {
  readonly statuses?: readonly FindingStatus[]
  readonly severities?: readonly FindingSeverity[]
  readonly workflows?: readonly FindingWorkflow[]
  readonly weakness?: string
  readonly limit?: number
}

export interface FindingTransition {
  readonly id: string
  readonly status: FindingStatus
  readonly reason: string
}

export interface FindingTransitionRecord {
  readonly id: string
  readonly findingId: string
  readonly fromStatus: FindingStatus
  readonly toStatus: FindingStatus
  readonly reason: string
  readonly createdAt: string
}

export interface SarifExport {
  readonly $schema: string
  readonly version: "2.1.0"
  readonly runs: readonly unknown[]
}

export interface EvidenceExport {
  readonly schemaVersion: "1.0"
  readonly generatedAt: string
  readonly snapshot?: { readonly id: string; readonly fingerprint: string; readonly root: string }
  readonly coverage: readonly FileCoverage[]
  readonly findings: readonly SecurityFinding[]
  readonly transitions: readonly FindingTransitionRecord[]
}
