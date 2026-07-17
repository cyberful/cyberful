// ── Engagement Workflow And Phase Registry ───────────────────────
// Defines public workflow and phase identifiers, order, required artifacts,
// source and capability policy, reports, persona locations, and phase budgets.
// → cyberful/src/subsystem/orchestrator.ts — advances workflows declared here.
// @docs/user-guide/workflows.md
// ─────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import path from "path"
import * as Builtin from "@/builtin"
import { isRecord } from "@/util/record"

export type PhaseOwner = "expert" | "unknown"

export type SourcePolicy = "none" | "read" | "review" | "remediate"

export type WorkflowCapability =
  | "source"
  | "code-graph"
  | "isolated-exec"
  | "git-review"
  | "remediation-git"
  | "browser"
  | "zap"

// ── Deliverables Are Host-Enforced Phase Contracts ───────────────
// Each workflow phase names the one structured artifact it must leave in the
// workarea. The phase runner includes that exact name in the prompt and rejects
// completion when the file is absent, so a persona cannot substitute an
// improvised filename that its successor will never read. Extra evidence remains
// allowed; this field identifies only the mandatory handoff artifact.
// ───────────────────────────────────────────────────────────────
interface PhaseDef {
  readonly name: string
  readonly deliverable?: string
}

// A selectable TUI workflow recorded on the session: `name` is the id and `title` the display label.
interface WorkflowBase {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly promptPlaceholder: {
    readonly lead: string
    readonly examples: readonly string[]
  }
  readonly personas: string
  readonly sourcePolicy: SourcePolicy
  readonly capabilities: readonly WorkflowCapability[]
  readonly completionTitle: string
  readonly nextWorkflow?: string
}

export interface WorkflowReport {
  readonly source: string
  readonly path: string
  readonly mime: string
}

export interface SequentialWorkflow extends WorkflowBase {
  readonly kind: "workflow"
  readonly phases: readonly PhaseDef[]
  readonly report: WorkflowReport
  readonly terminalArtifacts: readonly { label: string; path: string; mime: string; primary?: boolean }[]
}

export interface InteractiveWorkflow extends WorkflowBase {
  readonly kind: "interactive"
  readonly persona: string
  readonly requiresExistingWorkarea: boolean
}

export type EngagementWorkflow = SequentialWorkflow | InteractiveWorkflow

// The registry is the single source for sequential phases and interactive personas.
const WORKFLOWS: Record<string, EngagementWorkflow> = {
  pentest: {
    name: "pentest",
    title: "Pentest",
    description: "Authorized black-box and gray-box penetration testing against an engagement scope.",
    promptPlaceholder: {
      lead: "Pentest objective",
      examples: [
        "Test https://staging.example.com within the authorized scope",
        "Assess the authentication and account recovery flows",
        "Find exploitable vulnerabilities in this staging API",
      ],
    },
    kind: "workflow",
    personas: "pentest",
    sourcePolicy: "none",
    capabilities: ["isolated-exec", "browser", "zap"],
    completionTitle: "Pentest completed",
    nextWorkflow: "ask",
    phases: [
      { name: "brief", deliverable: "MISSION.md" },
      { name: "recon", deliverable: "RECON.md" },
      { name: "exploit", deliverable: "EXPLOIT.md" },
      { name: "hacker", deliverable: "HACKER.md" },
      { name: "verify", deliverable: "VERIFY.md" },
      { name: "report", deliverable: "REPORT.md" },
    ],
    report: { source: "REPORT.md", path: "reports/security-report.pdf", mime: "application/pdf" },
    terminalArtifacts: [
      { label: "Security report", path: "reports/security-report.pdf", mime: "application/pdf", primary: true },
    ],
  },
  "code-audit": {
    name: "code-audit",
    title: "Code Audit",
    description: "Repository-wide, graph-assisted source audit with verified findings and variant analysis.",
    promptPlaceholder: {
      lead: "Code audit objective",
      examples: [
        "Audit this repository for authentication vulnerabilities",
        "Trace untrusted input to security-sensitive sinks",
        "Find and verify vulnerabilities across the source tree",
      ],
    },
    kind: "workflow",
    personas: "code-audit",
    sourcePolicy: "read",
    capabilities: ["source", "code-graph", "isolated-exec"],
    completionTitle: "Code audit completed",
    nextWorkflow: "ask",
    phases: [
      { name: "scope", deliverable: "CODE_SCOPE.md" },
      { name: "index", deliverable: "CODE_GRAPH.md" },
      { name: "trace", deliverable: "CODE_TRACE.md" },
      { name: "hunt", deliverable: "CODE_HUNT.md" },
      { name: "verify", deliverable: "CODE_VERIFY.md" },
      { name: "report", deliverable: "CODE_AUDIT_REPORT.md" },
    ],
    report: { source: "CODE_AUDIT_REPORT.md", path: "reports/code-audit-report.pdf", mime: "application/pdf" },
    terminalArtifacts: [
      { label: "Code audit report", path: "reports/code-audit-report.pdf", mime: "application/pdf", primary: true },
      { label: "Code audit source", path: "CODE_AUDIT_REPORT.md", mime: "text/markdown" },
      { label: "SARIF findings", path: "reports/code-audit.sarif", mime: "application/sarif+json" },
    ],
  },
  assessment: {
    name: "assessment",
    title: "Assessment",
    description: "Whole-project security assessment spanning code, architecture, controls, supply chain, and runtime.",
    promptPlaceholder: {
      lead: "Assessment objective",
      examples: [
        "Assess this project's security posture end to end",
        "Evaluate the architecture, dependencies, and runtime controls",
        "Identify and prioritize the project's security risks",
      ],
    },
    kind: "workflow",
    personas: "assessment",
    sourcePolicy: "read",
    capabilities: ["source", "code-graph", "isolated-exec", "browser", "zap"],
    completionTitle: "Security assessment completed",
    nextWorkflow: "ask",
    phases: [
      { name: "brief", deliverable: "ASSESSMENT_MISSION.md" },
      { name: "map", deliverable: "ASSESSMENT_MAP.md" },
      { name: "controls", deliverable: "ASSESSMENT_CONTROLS.md" },
      { name: "test", deliverable: "ASSESSMENT_TEST.md" },
      { name: "correlate", deliverable: "ASSESSMENT_RISK.md" },
      { name: "verify", deliverable: "ASSESSMENT_VERIFY.md" },
      { name: "report", deliverable: "ASSESSMENT_REPORT.md" },
    ],
    report: {
      source: "ASSESSMENT_REPORT.md",
      path: "reports/security-assessment.pdf",
      mime: "application/pdf",
    },
    terminalArtifacts: [
      {
        label: "Security assessment",
        path: "reports/security-assessment.pdf",
        mime: "application/pdf",
        primary: true,
      },
      { label: "Assessment source", path: "ASSESSMENT_REPORT.md", mime: "text/markdown" },
      { label: "Assessment evidence", path: "reports/assessment-evidence.json", mime: "application/json" },
    ],
  },
  remediate: {
    name: "remediate",
    title: "Remediate",
    description: "Reproduce verified security findings, implement minimal fixes, and prove regressions are closed.",
    promptPlaceholder: {
      lead: "Remediation objective",
      examples: [
        "Fix the verified findings in this workarea",
        "Reproduce and patch the highest-severity vulnerability",
        "Implement minimal fixes and prove the regressions are closed",
      ],
    },
    kind: "workflow",
    personas: "remediate",
    sourcePolicy: "remediate",
    capabilities: ["source", "code-graph", "isolated-exec", "remediation-git", "browser", "zap"],
    completionTitle: "Remediation completed",
    nextWorkflow: "ask",
    phases: [
      { name: "intake", deliverable: "REMEDIATION_SCOPE.md" },
      { name: "plan", deliverable: "REMEDIATION_PLAN.md" },
      { name: "implement", deliverable: "REMEDIATION_CHANGES.md" },
      { name: "verify", deliverable: "REMEDIATION_VERIFY.md" },
      { name: "publish", deliverable: "REMEDIATION_REPORT.md" },
    ],
    report: { source: "REMEDIATION_REPORT.md", path: "REMEDIATION_REPORT.md", mime: "text/markdown" },
    terminalArtifacts: [
      { label: "Remediation report", path: "REMEDIATION_REPORT.md", mime: "text/markdown", primary: true },
      { label: "Remediation patch", path: "reports/remediation.patch", mime: "text/x-diff" },
      { label: "Publish record", path: "reports/remediation-publish.json", mime: "application/json" },
    ],
  },
  "secure-review": {
    name: "secure-review",
    title: "Secure Review",
    description: "Incremental security review of local Git changes and their graph-derived blast radius.",
    promptPlaceholder: {
      lead: "Secure review objective",
      examples: [
        "Review the current Git changes for security regressions",
        "Analyze this diff and its security blast radius",
        "Verify this branch is safe to merge",
      ],
    },
    kind: "workflow",
    personas: "secure-review",
    sourcePolicy: "review",
    capabilities: ["source", "code-graph", "isolated-exec", "git-review"],
    completionTitle: "Secure review completed",
    nextWorkflow: "ask",
    phases: [
      { name: "map", deliverable: "REVIEW_MAP.md" },
      { name: "audit", deliverable: "REVIEW_FINDINGS.md" },
      { name: "verify", deliverable: "SECURE_REVIEW.md" },
    ],
    report: { source: "SECURE_REVIEW.md", path: "SECURE_REVIEW.md", mime: "text/markdown" },
    terminalArtifacts: [
      { label: "Secure review", path: "SECURE_REVIEW.md", mime: "text/markdown", primary: true },
      { label: "SARIF findings", path: "reports/secure-review.sarif", mime: "application/sarif+json" },
    ],
  },
  ask: {
    name: "ask",
    title: "Ask",
    description: "Ask follow-up questions about an existing Cyberful workarea and its evidence.",
    promptPlaceholder: {
      lead: "Ask about this workarea",
      examples: [
        "Summarize the verified findings",
        "Which vulnerabilities should I fix first?",
        "Explain the evidence behind the highest-risk finding",
      ],
    },
    kind: "interactive",
    personas: "ask",
    sourcePolicy: "none",
    capabilities: ["isolated-exec", "browser", "zap"],
    completionTitle: "Answer completed",
    persona: "ask",
    requiresExistingWorkarea: true,
  },
}

const LEGACY_PHASE_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  pentest: {
    "pentest-exploit": "exploit",
    "pentest-hacker": "hacker",
    "pentest-verify": "verify",
    "pentest-report": "report",
  },
  "code-audit": {
    "code-scope": "scope",
    "code-index": "index",
    "code-trace": "trace",
    "code-hunt": "hunt",
    "code-verify": "verify",
    "code-report": "report",
  },
  assessment: {
    "assessment-brief": "brief",
    "assessment-map": "map",
    "assessment-controls": "controls",
    "assessment-test": "test",
    "assessment-correlate": "correlate",
    "assessment-verify": "verify",
    "assessment-report": "report",
  },
  remediate: {
    "remediate-intake": "intake",
    "remediate-plan": "plan",
    "remediate-implement": "implement",
    "remediate-verify": "verify",
    "remediate-publish": "publish",
  },
  "secure-review": {
    "review-map": "map",
    "review-audit": "audit",
    "review-verify": "verify",
  },
}

export function canonicalPhase(workflowName: string, phase: string): string {
  return LEGACY_PHASE_NAMES[workflowName]?.[phase] ?? phase
}

// ── Persisted Workflows Namespace Shared Phase Names ─────────────
// Semantic names such as verify and report intentionally appear in several
// workflows. Runtime lookups therefore require the persisted workflow and resolve
// only within its ordered chain; object iteration order can never choose a
// different workflow. Reverse discovery succeeds only for globally unique names,
// while kickoff discovery considers only a workflow's first phase or persona.
// ──────────────────────────────────────────────────────────────
function def(workflowName: string, agent: string): PhaseDef | undefined {
  const selected = WORKFLOWS[workflowName]
  if (selected?.kind !== "workflow") return
  const canonical = canonicalPhase(workflowName, agent)
  return selected.phases.find((phase) => phase.name === canonical)
}

// The workflows a session can start in, ordered as declared in the registry.
export function listWorkflows(): readonly EngagementWorkflow[] {
  return Object.values(WORKFLOWS)
}

export function isWorkflow(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(WORKFLOWS, name)
}

export function workflow(name: string): EngagementWorkflow | undefined {
  return WORKFLOWS[name]
}

export function workflowKickoffPhase(workflowName: string): string | undefined {
  const selected = WORKFLOWS[workflowName]
  if (!selected) return
  return selected.kind === "workflow" ? selected.phases[0]?.name : selected.persona
}

export function workflowOf(phase: string): string | undefined {
  const matches = Object.entries(WORKFLOWS).flatMap(([name, workflow]) => {
    const canonical = canonicalPhase(name, phase)
    if (workflow.kind === "workflow" && workflow.phases.some((candidate) => candidate.name === canonical)) return [name]
    if (workflow.kind === "interactive" && workflow.persona === canonical) return [name]
    return []
  })
  return matches.length === 1 ? matches[0] : undefined
}

export function workflowForKickoffAgent(agent: string): string | undefined {
  const matches = Object.values(WORKFLOWS).filter(
    (workflow) => workflowKickoffPhase(workflow.name) === canonicalPhase(workflow.name, agent),
  )
  return matches.length === 1 ? matches[0]?.name : undefined
}

// Unknown names are never reclassified as another runtime.
export function phaseOwner(workflowName: string, agent: string): PhaseOwner {
  return isExpertPhase(workflowName, agent) || isInteractiveAgent(workflowName, agent) ? "expert" : "unknown"
}

export function isExpertPhase(workflowName: string, agent: string): boolean {
  return def(workflowName, agent) !== undefined
}

// A recorded Expert or interactive turn keeps the session on its Codex runtime while idle.
export function sessionUsesCodexRuntime(
  workflowName: string,
  messages: readonly { role: string; agent?: string }[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      !!message.agent &&
      (isExpertPhase(workflowName, message.agent) || isInteractiveAgent(workflowName, message.agent)),
  )
}

export function deliverableFor(workflowName: string, agent: string): string | undefined {
  return def(workflowName, agent)?.deliverable
}

export function nextAfterExpertPhase(workflowName: string, phase: string): string | undefined {
  const selected = WORKFLOWS[workflowName]
  if (selected?.kind !== "workflow") return
  const canonical = canonicalPhase(workflowName, phase)
  const index = selected.phases.findIndex((candidate) => candidate.name === canonical)
  return index >= 0 ? selected.phases[index + 1]?.name : undefined
}

export function configRoot(): string {
  return process.env.CYBERFUL_CONFIG_DIR || Builtin.DIR
}

export function workflowHome(workflowName: string): string {
  const selected = WORKFLOWS[workflowName]
  if (!selected) throw new Error(`Unknown engagement workflow '${workflowName}'`)
  return path.join(configRoot(), "agents", selected.personas)
}

export function expertHome(): string {
  return workflowHome("pentest")
}

export function personaPath(home: string, phase: string): string {
  const personas = path.basename(home)
  const selected = Object.values(WORKFLOWS).find((workflow) => workflow.personas === personas)
  return path.join(home, `${selected ? canonicalPhase(selected.name, phase) : phase}.md`)
}

function rootForHome(home: string) {
  if (path.basename(home) === "agents") return path.dirname(home)
  if (path.basename(path.dirname(home)) === "agents") return path.dirname(path.dirname(home))
  return path.dirname(home)
}

export function cyberfulInstructionPath(home = expertHome()): string {
  return path.join(rootForHome(home), "instructions", "cyberful.md")
}

export function skillRoot(home = expertHome()): string {
  return path.join(rootForHome(home), "skills")
}

// Each workflow owns a host-enforced budgets.json. The default applies when it is missing or omits a persona.
export function budgetsPath(home: string): string {
  return path.join(home, "budgets.json")
}

export function isInteractiveAgent(workflowName: string, agent: string): boolean {
  const selected = WORKFLOWS[workflowName]
  return selected?.kind === "interactive" && selected.persona === canonicalPhase(workflowName, agent)
}

export function terminalArtifacts(workflowName: string) {
  const selected = WORKFLOWS[workflowName]
  return selected?.kind === "workflow" ? selected.terminalArtifacts : []
}

export function reportFor(workflowName: string): WorkflowReport | undefined {
  const selected = WORKFLOWS[workflowName]
  return selected?.kind === "workflow" ? selected.report : undefined
}

export function sourcePolicyFor(workflowName: string): SourcePolicy | undefined {
  return WORKFLOWS[workflowName]?.sourcePolicy
}

export function capabilitiesFor(workflowName: string): readonly WorkflowCapability[] {
  return WORKFLOWS[workflowName]?.capabilities ?? []
}

export function hasCapability(workflowName: string, capability: WorkflowCapability): boolean {
  return capabilitiesFor(workflowName).includes(capability)
}

export function completionTitleFor(workflowName: string): string | undefined {
  return WORKFLOWS[workflowName]?.completionTitle
}

export function nextWorkflow(workflowName: string): string | undefined {
  return WORKFLOWS[workflowName]?.nextWorkflow
}

// ── Container Identity Fits Docker's Runtime Hostname ─────────────
// A workarea basename is only a display label: unrelated projects commonly use
// the same label and must never share a Docker container. The canonical path and
// session id therefore supply a stable digest, while the readable label is
// capped so prefix, separator, and digest fit Linux's 63-character hostname.
// This keeps Docker creation and later cleanup on one collision-safe identity.
// ─────────────────────────────────────────────────────────────────

export function expertContainerName(workarea: string, sessionID: string): string {
  if (!path.isAbsolute(workarea) || !sessionID.trim())
    throw new Error("Container identity requires an absolute canonical workarea and session id.")
  const label =
    path
      .basename(workarea)
      .replace(/[^a-zA-Z0-9_.-]/g, "-")
      .slice(0, 19) || "default"
  const identity = createHash("sha256")
    .update(path.normalize(workarea))
    .update("\0")
    .update(sessionID)
    .digest("hex")
    .slice(0, 24)
  return `cyberful-os-expert-${label}-${identity}`
}
export const DEFAULT_PHASE_BUDGET_MINUTES = 30

export interface BudgetResolution {
  minutes: number
  warning?: string
}

// ── Invalid Budgets Degrade To A Visible Finite Limit ────────────
// A missing or hand-written invalid budget must never create an unlimited phase.
// Resolution chooses a positive finite configured value or a positive finite
// fallback, with the product default as the final guard. Every fallback carries
// a warning into phase status and the durable transcript, making degraded
// configuration visible while keeping the workflow executable.
// ──────────────────────────────────────────────────────────────
export function resolveBudgetMinutes(budgets: unknown, phase: string, fallbackMinutes: number): BudgetResolution {
  const fallback =
    Number.isFinite(fallbackMinutes) && fallbackMinutes > 0 ? fallbackMinutes : DEFAULT_PHASE_BUDGET_MINUTES
  if (!isRecord(budgets)) {
    return { minutes: fallback, warning: `Budget '${phase}' unavailable; using ${fallback} minutes.` }
  }
  const value = budgets[phase]
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return { minutes: value }
  const reason = value === undefined ? "missing" : "invalid"
  return { minutes: fallback, warning: `Budget '${phase}' is ${reason}; using ${fallback} minutes.` }
}

export function budgetMinutesFor(budgets: unknown, phase: string, fallbackMinutes: number): number {
  return resolveBudgetMinutes(budgets, phase, fallbackMinutes).minutes
}

export * as SubsystemPhase from "./phase"
