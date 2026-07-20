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

export type SourcePolicy = "none" | "read"

export type WorkflowCapability =
  | "source"
  | "code-graph"
  | "isolated-exec"
  | "audit-diff"
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

// The registry is the single source for the two selectable security workflows.
const WORKFLOWS: Record<string, SequentialWorkflow> = {
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
    description:
      "Deep source audit spanning architecture, dataflow, supply chain, controls, and isolated runtime attack.",
    promptPlaceholder: {
      lead: "Code audit objective",
      examples: [
        "Audit this repository for authentication vulnerabilities",
        "Review the current branch diff and its security blast radius",
        "Threat-model the architecture, dependencies, and trust boundaries",
        "Trace untrusted input to security-sensitive sinks",
        "Find and verify vulnerabilities across the source tree",
      ],
    },
    kind: "workflow",
    personas: "code-audit",
    sourcePolicy: "read",
    capabilities: ["source", "code-graph", "isolated-exec", "audit-diff"],
    completionTitle: "Code audit completed",
    nextWorkflow: "ask",
    phases: [
      { name: "scope", deliverable: "CODE_SCOPE.md" },
      { name: "index", deliverable: "CODE_GRAPH.md" },
      { name: "trace", deliverable: "CODE_TRACE.md" },
      { name: "hunt", deliverable: "CODE_HUNT.md" },
      { name: "attack", deliverable: "CODE_ATTACK.md" },
      { name: "verify", deliverable: "CODE_VERIFY.md" },
      { name: "report", deliverable: "CODE_AUDIT_REPORT.md" },
    ],
    report: { source: "CODE_AUDIT_REPORT.md", path: "reports/code-audit-report.pdf", mime: "application/pdf" },
    terminalArtifacts: [
      { label: "Code audit report", path: "reports/code-audit-report.pdf", mime: "application/pdf", primary: true },
      { label: "Code audit source", path: "CODE_AUDIT_REPORT.md", mime: "text/markdown" },
      { label: "SARIF findings", path: "reports/code-audit.sarif", mime: "application/sarif+json" },
      { label: "Audit evidence", path: "reports/code-audit-evidence.json", mime: "application/json" },
    ],
  },
}

// Ask is a post-completion surface bound to an existing workflow workarea. It
// is deliberately outside the workflow registry and cannot start a session.
const FOLLOW_UP: InteractiveWorkflow = {
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
}

function runtimeDefinition(name: string): EngagementWorkflow | undefined {
  return WORKFLOWS[name] ?? (name === FOLLOW_UP.name ? FOLLOW_UP : undefined)
}

function runtimeEntries(): readonly (readonly [string, EngagementWorkflow])[] {
  return [...Object.entries(WORKFLOWS), [FOLLOW_UP.name, FOLLOW_UP]]
}

export function canonicalPhase(_workflowName: string, phase: string): string {
  return phase
}

// ── Persisted Workflows Namespace Shared Phase Names ─────────────
// Semantic names such as verify and report intentionally appear in several
// workflows. Runtime lookups therefore require the persisted workflow and resolve
// only within its ordered chain; object iteration order can never choose a
// different workflow. Reverse discovery succeeds only for globally unique names,
// while kickoff discovery considers only a workflow's first phase or persona.
// ──────────────────────────────────────────────────────────────
function def(workflowName: string, agent: string): PhaseDef | undefined {
  const selected = runtimeDefinition(workflowName)
  if (selected?.kind !== "workflow") return
  const canonical = canonicalPhase(workflowName, agent)
  return selected.phases.find((phase) => phase.name === canonical)
}

// The two security workflows a session can start from the welcome screen.
// Interactive follow-up surfaces remain addressable by the completed session
// but never appear as another selectable workflow.
export function listWorkflows(): readonly SequentialWorkflow[] {
  return Object.values(WORKFLOWS)
}

export function isWorkflow(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(WORKFLOWS, name)
}

export function workflow(name: string): EngagementWorkflow | undefined {
  return runtimeDefinition(name)
}

export function workflowKickoffPhase(workflowName: string): string | undefined {
  const selected = runtimeDefinition(workflowName)
  if (!selected) return
  return selected.kind === "workflow" ? selected.phases[0]?.name : selected.persona
}

export function workflowOf(phase: string): string | undefined {
  const matches = runtimeEntries().flatMap(([name, workflow]) => {
    const canonical = canonicalPhase(name, phase)
    if (workflow.kind === "workflow" && workflow.phases.some((candidate) => candidate.name === canonical)) return [name]
    if (workflow.kind === "interactive" && workflow.persona === canonical) return [name]
    return []
  })
  return matches.length === 1 ? matches[0] : undefined
}

export function workflowForKickoffAgent(agent: string): string | undefined {
  const matches = runtimeEntries().map(([, definition]) => definition).filter(
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
  const selected = runtimeDefinition(workflowName)
  if (selected?.kind !== "workflow") return
  const canonical = canonicalPhase(workflowName, phase)
  const index = selected.phases.findIndex((candidate) => candidate.name === canonical)
  return index >= 0 ? selected.phases[index + 1]?.name : undefined
}

export function configRoot(): string {
  return process.env.CYBERFUL_CONFIG_DIR || Builtin.DIR
}

export function workflowHome(workflowName: string): string {
  const selected = runtimeDefinition(workflowName)
  if (!selected) throw new Error(`Unknown engagement workflow '${workflowName}'`)
  return path.join(configRoot(), "agents", selected.personas)
}

export function expertHome(): string {
  return workflowHome("pentest")
}

export function personaPath(home: string, phase: string): string {
  const personas = path.basename(home)
  const selected = runtimeEntries().map(([, definition]) => definition).find((workflow) => workflow.personas === personas)
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

export function trustBoundaryInstructionPath(home = expertHome()): string {
  return path.join(rootForHome(home), "instructions", "trust-boundary.md")
}

export function skillRoot(home = expertHome()): string {
  return path.join(rootForHome(home), "skills")
}

// Each workflow owns a host-enforced budgets.json. The default applies when it is missing or omits a persona.
export function budgetsPath(home: string): string {
  return path.join(home, "budgets.json")
}

export function isInteractiveAgent(workflowName: string, agent: string): boolean {
  const selected = runtimeDefinition(workflowName)
  return selected?.kind === "interactive" && selected.persona === canonicalPhase(workflowName, agent)
}

export function terminalArtifacts(workflowName: string) {
  const selected = runtimeDefinition(workflowName)
  return selected?.kind === "workflow" ? selected.terminalArtifacts : []
}

export function reportFor(workflowName: string): WorkflowReport | undefined {
  const selected = runtimeDefinition(workflowName)
  return selected?.kind === "workflow" ? selected.report : undefined
}

export function sourcePolicyFor(workflowName: string): SourcePolicy | undefined {
  return runtimeDefinition(workflowName)?.sourcePolicy
}

export function capabilitiesFor(workflowName: string): readonly WorkflowCapability[] {
  return runtimeDefinition(workflowName)?.capabilities ?? []
}

export function hasCapability(workflowName: string, capability: WorkflowCapability): boolean {
  return capabilitiesFor(workflowName).includes(capability)
}

export function completionTitleFor(workflowName: string): string | undefined {
  return runtimeDefinition(workflowName)?.completionTitle
}

export function nextWorkflow(workflowName: string): string | undefined {
  return runtimeDefinition(workflowName)?.nextWorkflow
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
