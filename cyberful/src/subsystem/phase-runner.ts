// ── Pi Phase Runner ───────────────────────────────────────────────
// Runs one phase with its persona and gateway, then validates process
// exit, required artifact, handoff or budget cutoff, cleanup, and transcript results.
// → cyberful/src/subsystem/phase.ts — supplies workflow policy, capability scope, and paths.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import path from "path"
import os from "os"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { readFile, mkdir, access, rm, lstat, open } from "fs/promises"
import { Settings } from "@/config/settings"
import { Subsystem } from "./subsystem"
import { SubsystemCli } from "./cli"
import { SubsystemGateway } from "./gateway/config"
import { SubsystemPhase } from "./phase"
import type { AskHuman } from "./human-question"
import { SubsystemApprovalState } from "./approval-state"
import { SubsystemCompletion, type Candidate as CompletionCandidate } from "./completion"
import { SubsystemNovelty, type Contract as NoveltyContract } from "./novelty"
import { SubsystemUsage, type ContextChurn, type Totals as UsageTotals } from "./usage"
import { SubsystemVerdict, type Ledger as VerdictLedger } from "./verdict"
import type { DynamicTool, SubsystemFailure } from "./subsystem"
import { verifyCodeGraphReadiness } from "./gateway/code-graph-tools"
import { ensureWorkareaDirectory, replaceWorkareaFile } from "@/workarea"
import { AgentPromptCompiler, type PromptManifest } from "./prompt-compiler"
import { PiSkills, type SkillRegistry } from "./pi-skills"
import { SubsystemPiAgent } from "./pi-agent"

export interface PhaseSpec {
  phase: string
  workflow?: string
  kind?: "workflow" | "interactive"
  sessionID: string
  // The workarea directory; writes are physically jailed here (it is the worker's cwd).
  workareaCwd: string
  // Read-only project root published only to the private gateway. Every AgentRun remains confined to
  // the workarea and must use source tools rather than host file writes against this path.
  sourceRoot?: string
  // The first-party agents directory holding this phase's persona and embedded policy.
  home: string
  // Directory containing the operator-owned settings.yaml. Defaults to the
  // Cyberful launch directory rather than the assessed project.
  settingsDirectory?: string
  // What this phase must accomplish, seeded from the prior handoff.
  objective: string
  timeoutMs: number
  abort?: AbortSignal
  // Absolute file to persist this excursion's raw AgentEvent transcript to (the caller resolves it,
  // normally beside the session journal via SessionReportLog.expertTranscriptFile). Unset ⇒ no
  // transcript is kept and the phase may take the cheaper buffered path.
  transcriptPath?: string
  // Private environment for the phase gateway and its upstreams. It is deliberately excluded from
  // AgentRun context: recon routing and ZAP keys are capabilities, not model-readable secrets.
  env?: Record<string, string>
  // Every chain phase must explicitly call the gateway's handoff tool.
  // The host records the request out-of-band, shuts down the in-process phase owner, then validates the
  // requested successor before the orchestrator advances.
  handoff?: { successor?: string }
}

export interface PhaseHandoff {
  phase: string
  successor?: string
  summary: string
  artifact?: string
  completion?: CompletionCandidate
  verdicts?: VerdictLedger
}

export type PhaseFailureSource = "provider" | "contract" | "lifecycle"

export interface PhaseFailure {
  readonly phase: string
  readonly source: PhaseFailureSource
  readonly class: string
  readonly code?: string
  readonly detail: string
}

export interface PhaseResult {
  phase: string
  // Authorizes the orchestrator to accept this phase's handoff. A budget-exhausted phase can remain
  // degraded while passing this gate after the host seals its partial artifact and synthesizes a handoff.
  ok: boolean
  // The phase's final reply text (its structured handoff summary), envelope already unwrapped.
  summary: string
  exitCode: number
  timedOut: boolean
  termination: SubsystemCli.RunTermination
  backend: string
  durationMs: number
  limitMs: number
  effectiveLimitMs: number
  deadlineAt: number
  // Human-wait time is excluded from durationMs and extends deadlineAt by this amount.
  approvalWaitMs?: number
  warnings: string[]
  handoff?: PhaseHandoff
  // Relative path to the host-generated SHA-256 manifest for the final named deliverable. The host
  // writes it only after the Pi worker owner has shut down and the gateway is gone, so it cannot
  // race a last agent edit.
  artifactManifest?: string
  // Host-owned runtime provenance; unlike the deliverable checksum this is JSON status evidence.
  runtimeManifest?: string
  // Tool activity is not progress by itself. These fields count only distinct host-observed contents of
  // the required deliverable, each saved as an atomic last-known-good checkpoint while the phase runs.
  semanticCheckpoints?: number
  lastSemanticProgressAt?: number
  subsystemFailure?: SubsystemFailure
  // One authoritative terminal cause drives orchestration and presentation.
  // Additional non-primary degradation remains in warnings.
  phaseFailure?: PhaseFailure
  // Subsystem-neutral counters and derived context-reuse metrics cover the phase
  // root and its descendant AgentRuns.
  usage?: UsageTotals
  contextChurn?: ContextChurn
  reasoningObservability?: {
    readonly items: number
    readonly summaryItems: number
    readonly contentItems: number
    readonly deltaItems: number
    readonly textStatus: "published" | "only counters received" | "no reasoning observed"
  }
  agentRun?: {
    readonly id: string
    readonly provider: string
    readonly model: string
    readonly providerAffinity: "main" | "fallback"
    readonly promptManifest: PromptManifest
    readonly childRunIDs: readonly string[]
    readonly skillsUsed: readonly string[]
    readonly toolCalls: number
    readonly fallbackAdmissions: number
    readonly fallbackDescendants: number
  }
  noveltyContract?: NoveltyContract
}

export interface SemanticProgress {
  phase: string
  artifact: string
  checkpoint: string
  sha256: string
  count: number
  timestamp: number
}

export interface TranscriptWriter {
  append(line: string): Promise<void>
  close(): Promise<void>
}

// Injected so the spawn contract is testable without a live external CLI or real filesystem.
export interface PhaseDeps {
  run: typeof SubsystemCli.run
  runStreaming: typeof SubsystemCli.runStreaming
  subsystem: Subsystem.Subsystem
  loadSettings: (directory: string) => Promise<Settings.Info>
  discoverSkills: (roots: readonly string[]) => Promise<SkillRegistry>
  // Reads budgets.json. Injected so budget resolution remains testable.
  readFile: (filePath: string) => Promise<string>
  // Shells may materialize heredocs before the command runs. Production creates their private temporary
  // directory inside the already-authorized workarea so this preparation cannot escape the sandbox.
  ensureDirectory: (directory: string) => Promise<void>
  // Production validates the named deliverable on disk; optional only so narrowly-scoped test adapters
  // predating this check can opt out instead of emulating a filesystem.
  fileExists?: (filePath: string) => Promise<boolean>
  writeArtifactManifest?: (manifestPath: string, artifactPath: string) => Promise<void>
  writeRuntimeManifest?: (manifestPath: string, workarea: string, result: PhaseResult) => Promise<void>
  writeArtifactCheckpoint?: (checkpointPath: string, artifactPath: string) => Promise<string>
  now?: () => number
  removeFile?: (filePath: string) => Promise<void>
  removeDirectory?: (directory: string) => Promise<void>
  // Production reads the gateway's startup PID, reaps its process group after the in-process Pi owner
  // closes its bridge, and proves the group is gone. A handoff phase requires the registration because it
  // necessarily used the gateway.
  waitForGatewayExit?: (signalPath: string, timeoutMs: number, registrationRequired: boolean) => Promise<boolean>
  // When set, the phase streams every activity item mapped from AgentRun events
  // (subsystem.streamActivities) as it happens, so the TUI shows the phase
  // working live. Unset (the default) runs the CLI buffered.
  onActivity?: (activity: Subsystem.PhaseActivity) => void
  onSemanticProgress?: (progress: SemanticProgress) => void
  // Opens one private append-only transcript owned by the phase.
  createTranscript?: (filePath: string) => Promise<TranscriptWriter>
  // Production binds this to the session's in-process Question service. When absent (small unit adapters
  // and non-interactive callers), the gateway correctly omits `question` instead of exposing a dead tool.
  askQuestion?: AskHuman
  // The Code Audit index phase cannot authorize trace until source preflight and current graph coverage
  // match the gateway's host-keyed readiness attestation.
  verifyCodeGraphReadiness?: (environment: Readonly<Record<string, string | undefined>>) => Promise<unknown>
  // Host-owned structured tools are bound to the active session and phase. They
  // travel through the subsystem protocol without entering the phase gateway.
  dynamicTools?: readonly DynamicTool[]
}

function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

async function pathExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false
    throw error
  }
}

async function operationWarning(label: string, operation?: () => Promise<void>) {
  if (!operation) return undefined
  try {
    await operation()
    return undefined
  } catch (error) {
    return `${label}: ${errorDetail(error)}`
  }
}

async function operationWarnings(operations: ReadonlyArray<readonly [string, (() => Promise<void>) | undefined]>) {
  const warnings = await Promise.all(operations.map(([label, operation]) => operationWarning(label, operation)))
  return warnings.filter((warning): warning is string => warning !== undefined)
}

export function defaultDeps(): PhaseDeps {
  return {
    run: SubsystemCli.run,
    runStreaming: SubsystemCli.runStreaming,
    subsystem: Subsystem.pi,
    loadSettings: Settings.load,
    discoverSkills: (roots) => PiSkills.discover({ roots }),
    readFile: (filePath) => readFile(filePath, "utf8"),
    ensureDirectory: (directory) =>
      ensureWorkareaDirectory(path.dirname(directory), path.basename(directory)).then(() => {}),
    fileExists: pathExists,
    writeArtifactManifest,
    writeRuntimeManifest,
    writeArtifactCheckpoint,
    now: Date.now,
    removeFile: (filePath) => rm(filePath, { force: true }),
    removeDirectory: (directory) => rm(directory, { recursive: true, force: true }),
    waitForGatewayExit,
    verifyCodeGraphReadiness,
    createTranscript: async (filePath) => {
      await mkdir(path.dirname(filePath), { recursive: true })
      const handle = await open(
        filePath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_TRUNC |
          (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
        0o600,
      )
      await handle.chmod(0o600)
      let queue = Promise.resolve()
      const failures: unknown[] = []
      return {
        append(line) {
          const task = queue.then(() => handle.write(line).then(() => {}))
          queue = task.catch((error) => {
            failures.push(error)
          })
          return queue
        },
        async close() {
          await queue
          await handle.close().catch((error) => {
            failures.push(error)
          })
          if (failures.length > 0)
            throw new AggregateError(failures, `phase transcript '${filePath}' could not be finalized`)
        },
      }
    },
  }
}

export async function writeArtifactCheckpoint(checkpointPath: string, artifactPath: string) {
  const workarea = path.dirname(artifactPath)
  const relativeCheckpoint = containedArtifactPath(workarea, checkpointPath, "phase-checkpoints", [4, 5])
  const entry = await lstat(artifactPath)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("checkpoint artifact must be a regular file")
  const artifact = await open(
    artifactPath,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
  )
  const bytes = await artifact.readFile().finally(() => artifact.close())
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  await replaceWorkareaFile(workarea, relativeCheckpoint, bytes)
  return sha256
}

export async function writeArtifactManifest(manifestPath: string, artifactPath: string) {
  const workarea = path.dirname(artifactPath)
  const relativeManifest = containedArtifactPath(workarea, manifestPath, "phase-manifests", [3, 4])
  const artifactEntry = await lstat(artifactPath)
  if (!artifactEntry.isFile() || artifactEntry.isSymbolicLink())
    throw new Error("the required artifact must be a regular file, not a link")
  const artifact = await open(
    artifactPath,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
  )
  const bytes = await artifact.readFile().finally(() => artifact.close())
  await replaceWorkareaFile(
    workarea,
    relativeManifest,
    `${createHash("sha256").update(bytes).digest("hex")}  ${path.basename(artifactPath)}\n`,
  )
}

export async function writeRuntimeManifest(manifestPath: string, workarea: string, result: PhaseResult) {
  const relativeManifest = containedArtifactPath(workarea, manifestPath, "phase-manifests", [3, 4])
  const payload = {
    version: 3,
    phase: result.phase,
    termination: result.termination,
    backend: result.backend,
    subsystemFailure: result.subsystemFailure,
    usage: result.usage,
    contextChurn: result.contextChurn,
    reasoningObservability: result.reasoningObservability,
    agentRun: result.agentRun,
    noveltyContract: result.noveltyContract,
    verdicts: result.handoff?.verdicts ? SubsystemVerdict.counts(result.handoff.verdicts) : undefined,
  }
  await replaceWorkareaFile(workarea, relativeManifest, `${JSON.stringify(payload, null, 2)}\n`)
}

function containedArtifactPath(workarea: string, destination: string, directory: string, segmentCounts: number[]) {
  const relative = path.relative(path.resolve(workarea), path.resolve(destination))
  const segments = relative.split(path.sep)
  if (
    path.isAbsolute(relative) ||
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    !segmentCounts.includes(segments.length) ||
    segments[0] !== "raw" ||
    segments[1] !== directory ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new Error(`artifact ${directory} must stay in the workarea raw/${directory} directory`)
  return relative
}

export function artifactManifestPath(spec: Pick<PhaseSpec, "workflow" | "phase" | "workareaCwd">) {
  return path.join(
    spec.workareaCwd,
    "raw",
    "phase-manifests",
    ...(spec.workflow ? [artifactPathSegment(spec.workflow, "workflow")] : []),
    `${artifactPathSegment(spec.phase, "phase")}.sha256`,
  )
}

export function runtimeManifestPath(spec: Pick<PhaseSpec, "workflow" | "phase" | "workareaCwd">) {
  return path.join(
    spec.workareaCwd,
    "raw",
    "phase-manifests",
    ...(spec.workflow ? [artifactPathSegment(spec.workflow, "workflow")] : []),
    `${artifactPathSegment(spec.phase, "phase")}.runtime.json`,
  )
}

function phaseDeliverable(spec: Pick<PhaseSpec, "workflow" | "phase">) {
  const workflow = spec.workflow ?? SubsystemPhase.workflowOf(spec.phase)
  return workflow ? SubsystemPhase.deliverableFor(workflow, spec.phase) : undefined
}

export function artifactCheckpointPath(spec: Pick<PhaseSpec, "workflow" | "phase" | "workareaCwd">) {
  return path.join(
    spec.workareaCwd,
    "raw",
    "phase-checkpoints",
    ...(spec.workflow ? [artifactPathSegment(spec.workflow, "workflow")] : []),
    artifactPathSegment(spec.phase, "phase"),
    phaseDeliverable(spec) ?? "artifact",
  )
}

function artifactPathSegment(value: string, label: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) throw new Error(`Invalid ${label} artifact path segment '${value}'.`)
  return value
}

export function circuitBreakerDirectory(sessionID: string) {
  return path.join(os.tmpdir(), `expert-circuit-breaker-${sessionID.replace(/[^a-zA-Z0-9_.-]/g, "-")}`)
}

export function circuitBreakerPath(sessionID: string, owner: string) {
  return path.join(circuitBreakerDirectory(sessionID), `${owner.replace(/[^a-zA-Z0-9_.-]/g, "-")}.json`)
}

export interface GatewayReapDeps {
  readSignal: (signalPath: string) => Promise<string>
  now: () => number
  sleep: (ms: number) => Promise<void>
  processAlive: (pid: number) => boolean
  processGroupAlive: (pid: number) => boolean
  signalProcess: (pid: number, signal: NodeJS.Signals) => void
  killTree: (pid: number, signal: NodeJS.Signals) => void
}

const gatewayReapDeps: GatewayReapDeps = {
  readSignal: (signalPath) => readFile(signalPath, "utf8"),
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  processAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (errorCode(error) === "ESRCH") return false
      if (errorCode(error) === "EPERM") return true
      throw error
    }
  },
  processGroupAlive: (pid) => {
    if (process.platform === "win32") return false
    try {
      process.kill(-pid, 0)
      return true
    } catch (error) {
      if (errorCode(error) === "ESRCH") return false
      if (errorCode(error) === "EPERM") return true
      throw error
    }
  },
  signalProcess: (pid, signal) => {
    try {
      process.kill(pid, signal)
    } catch (error) {
      if (errorCode(error) !== "ESRCH") throw error
    }
  },
  killTree: SubsystemCli.killTree,
}

async function waitUntilGatewayGone(pid: number, deadline: number, deps: GatewayReapDeps): Promise<boolean> {
  while (deps.now() <= deadline) {
    if (!deps.processAlive(pid) && !deps.processGroupAlive(pid)) return true
    await deps.sleep(20)
  }
  return !deps.processAlive(pid) && !deps.processGroupAlive(pid)
}

// ── Gateway Registration Survives Transport Close ───────────────
// The MCP transport may close unexpectedly, so an exit-time marker is
// inherently racy. The gateway instead registers its PID at startup. Once the
// in-process Pi worker owner has closed its bridge, first request a graceful
// gateway close; if any member of its process group survives, group-kill it
// before returning to the orchestrator.
// ─────────────────────────────────────────────────────────────────
export async function waitForGatewayExit(
  signalPath: string,
  timeoutMs: number,
  registrationRequired: boolean,
  deps: GatewayReapDeps = gatewayReapDeps,
): Promise<boolean> {
  const startedAt = deps.now()
  const deadline = startedAt + Math.max(0, timeoutMs)
  const registrationDeadline = Math.min(deadline, startedAt + 500)
  let gatewayPID: number | undefined
  while (deps.now() <= registrationDeadline) {
    try {
      const parsed: unknown = JSON.parse(await deps.readSignal(signalPath))
      if (isRecord(parsed) && typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 1) {
        gatewayPID = parsed.pid
        break
      }
    } catch (error) {
      // Registration is written atomically in production, but injected adapters and a process killed
      // mid-write can expose a missing or incomplete marker while this bounded poll is still active.
      if (!(error instanceof SyntaxError) && errorCode(error) !== "ENOENT") throw error
    }
    await deps.sleep(20)
  }
  // An optional one-shot run can finish without ever starting its MCP server. Chain phases cannot: their handoff
  // was served by this gateway, so a missing registration means its lifecycle cannot be proven.
  if (gatewayPID === undefined) return !registrationRequired
  if (await waitUntilGatewayGone(gatewayPID, Math.min(deadline, deps.now() + 100), deps)) return true

  // SIGTERM lets the gateway close its upstream clients. SIGKILL targets the detached process group only
  // if that bounded close fails, preventing an orphaned browser/cyberful-os child from crossing phases.
  deps.signalProcess(gatewayPID, "SIGTERM")
  if (await waitUntilGatewayGone(gatewayPID, Math.min(deadline, deps.now() + 3_000), deps)) return true
  deps.killTree(gatewayPID, "SIGKILL")
  deps.signalProcess(gatewayPID, "SIGKILL")
  return waitUntilGatewayGone(gatewayPID, deadline, deps)
}

// Host-owned phase mechanics belong in the immutable system message. Operator
// objective, attachments, explicit context, and the historical API `system`
// field remain user-level content compiled separately.
export function buildPhasePrompt(spec: PhaseSpec, budgetMinutes: number, novelty?: NoveltyContract): string {
  if (spec.kind === "interactive")
    return [
      `You are running one autonomous Ask turn in the existing Cyberful workarea (${spec.workareaCwd}).`,
      "Use the complete gateway and filesystem capabilities when they improve the answer. Stay inside the",
      "authorized engagement scope, preserve existing evidence, and write reusable results to the workarea.",
      "Do not call handoff. End with the concise Markdown answer that should be shown directly to the user.",
      "",
      "## Time budget",
      `You have up to ${budgetMinutes} minutes for this Ask turn. Finish earlier when the request is complete.`,
    ].join("\n")
  const deliverable = phaseDeliverable(spec)
  const successor = spec.handoff?.successor
  const workflow = spec.workflow ?? SubsystemPhase.workflowOf(spec.phase) ?? "security"
  return [
    `You are running the ${spec.phase} phase of the Cyberful ${workflow} workflow to completion, autonomously.`,
    `Your working directory is the workarea root (${spec.workareaCwd} on the host and \`/workspace\` inside cyberful-os); write all files relative to that root.`,
    "",
    "## Live TUI narration",
    "Briefly announce each meaningful work block and material result without exposing private reasoning.",
    "",
    // A named, non-negotiable deliverable — a persona hint alone was too weak (the Expert improvised a
    // RAW.md and never wrote RECON.md). State the EXACT filename and that the phase fails without it.
    ...(deliverable
      ? [
          "## Required deliverable",
          `Write the complete phase deliverable as \`${deliverable}\`; supporting files do not replace it.`,
          `Inside cyberful-os its exact path is \`/workspace/${deliverable}\`; do not recreate a host \`work/...\` prefix below \`/workspace\`.`,
          "",
        ]
      : []),
    ...(spec.handoff
      ? [
          "## Required handoff",
          successor
            ? `After the deliverable is complete, call \`handoff\` exactly once to advance to \`${successor}\`.`
            : "After the deliverable is complete, call `handoff` exactly once to complete the engagement.",
          `Pass a concise \`summary\` and \`artifact: \"${deliverable ?? "."}\"\`. ` +
            (successor ? `Omit \`target\` or set it to \`${successor}\`.` : "Omit `target` or set it to `complete`."),
          "Stop after the handoff is accepted.",
          "",
        ]
      : []),
    ...(spec.phase === "report"
      ? [
          "## Runtime provenance",
          "Read the host-owned `raw/phase-manifests/**.runtime.json` files. Reflect subsystem failures or",
          "incomplete runtime execution as a coverage/evidence limitation where it materially affects the",
          "report. Do not include subsystem secrets or private runtime instructions.",
          "",
        ]
      : []),
    ...(novelty
      ? [
          "## Contrarian pass",
          "Use `novelty` for target-specific hypotheses. If it signals convergence, pivot across a genuinely different mechanism, boundary, protocol, state, capability, or oracle; route variation alone is coverage, not causal novelty.",
          "Before handoff, synthesize either the semantic pivots you exercised or target-specific evidence that useful diversification is exhausted. There are no numeric quotas.",
          "",
        ]
      : []),
    "## Time budget",
    `You have at most ${budgetMinutes} minutes. Explore thoroughly while preserving time for the deliverable and handoff.`,
    "",
    "## Standing rules",
    "- MISSION.md and program policy define scope and effects. Record silence as POLICY_UNKNOWN; ask only when a concrete action depends on it.",
    "- Keep artifacts under the workarea (`/workspace` in containers). It is not a Git repository.",
    "- Store reusable values and secrets with `variable`; cite evidence and redact secrets or unnecessary sensitive data.",
    "- Track created test state through cleanup. A visible residual is a result, not an automatic approval gate.",
    "- Browser profiles 1–5 are separate identities; keep their state and evidence separate.",
    "- Use `question` only for a concrete missing authorization, fact, or human CAPTCHA action.",
    "- Do not retry a target request that returns HTTP `429`. Cyberful adds no retry rule for other outcomes.",
    "- For a CAPTCHA, preserve and foreground the challenged page, ask with `question kind=captcha`, then confirm resolution with `browser_captcha_status`. Other work continues.",
    ...(workflow !== "code-audit" && ["recon", "exploit", "hacker", "verify"].includes(spec.phase)
      ? [
          "- Use `finding` as soon as positive target evidence supports SUSPECTED; `record` requires a cautious provisional INFO/LOW/MEDIUM/HIGH/CRITICAL severity. Do not register mere hypotheses or backlog.",
          "- Revisit historical findings explicitly, then update every technical, verification, severity, or Bug Bounty submission decision.",
          ...(spec.phase === "exploit" || spec.phase === "hacker"
            ? ["- Before handoff, use `finding list` and reconcile the handoff verdict inventory with the registry."]
            : []),
          ...(spec.phase === "verify"
            ? [
                "- Before handoff, give every current finding its final workflow verification and Bug Bounty submission decision.",
              ]
            : []),
        ]
      : []),
    ...(spec.phase === "report"
      ? ["- The `finding` registry is read-only in Report; use list/get and report its structured decisions."]
      : []),
    ...(spec.handoff
      ? [
          "- Do your work, write your artifact(s), then call `handoff` with the structured summary. The next",
          "  phase reads that summary and the workarea, not this phase's transcript.",
        ]
      : [
          "- Do your work, write your artifact(s), and end with a concise structured summary. The phase result",
          "  phase reads the workarea, not this phase's transcript.",
        ]),
  ].join("\n")
}

// Read once at the process boundary. Invalid configuration still yields a finite ceiling, and the
// resolution carries its warning into the durable status rather than hiding the default in a catch.
interface PhasePolicyResolution extends SubsystemPhase.BudgetResolution {
  readonly novelty?: NoveltyContract
  readonly noveltyWarning?: string
}

async function readBudget(
  read: PhaseDeps["readFile"],
  budgetsPath: string,
  phase: string,
  defaultMinutes: number,
): Promise<PhasePolicyResolution> {
  try {
    const parsed: unknown = JSON.parse(await read(budgetsPath))
    const budget = SubsystemPhase.resolveBudgetMinutes(parsed, phase, defaultMinutes)
    const novelty = SubsystemNovelty.resolve(parsed, phase)
    return {
      ...budget,
      ...(novelty.contract ? { novelty: novelty.contract } : {}),
      ...(novelty.warning ? { noveltyWarning: novelty.warning } : {}),
    }
  } catch (error) {
    const defaultBudget = SubsystemPhase.resolveBudgetMinutes(undefined, phase, defaultMinutes)
    return {
      ...defaultBudget,
      warning: `Could not load budget configuration: ${errorDetail(error)} ${defaultBudget.warning ?? ""}`.trim(),
    }
  }
}

async function readHandoff(
  read: PhaseDeps["readFile"],
  signalPath: string,
  spec: PhaseSpec,
): Promise<{ value?: PhaseHandoff; warning?: string; missing: boolean }> {
  try {
    const parsed: unknown = JSON.parse(await read(signalPath))
    if (!isRecord(parsed)) return { warning: "Required handoff is not a JSON object.", missing: false }
    const successor = typeof parsed.successor === "string" ? parsed.successor : undefined
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : ""
    const artifact = typeof parsed.artifact === "string" ? parsed.artifact : undefined
    const completion = SubsystemCompletion.parseCandidate(parsed.completion)
    const verdicts = SubsystemVerdict.parse(parsed.verdicts)
    if (parsed.phase !== spec.phase)
      return { warning: "Handoff phase does not match the running phase.", missing: false }
    if (successor !== spec.handoff?.successor)
      return { warning: "Handoff successor does not match the configured chain.", missing: false }
    if (!summary) return { warning: "Handoff summary is empty.", missing: false }
    if (SubsystemVerdict.requiredFor(spec.workflow, spec.phase) && !verdicts)
      return { warning: "Handoff requires a structured verdict inventory for this phase.", missing: false }
    return {
      value: {
        phase: spec.phase,
        successor,
        summary,
        artifact,
        completion,
        ...(verdicts ? { verdicts } : {}),
      },
      missing: false,
    }
  } catch (error) {
    const missing = errorCode(error) === "ENOENT"
    return {
      warning: missing
        ? "Required handoff was not completed: no handoff was recorded."
        : `Required handoff was not completed: ${errorDetail(error)}`,
      missing,
    }
  }
}

function processTermination(result: SubsystemCli.RunResult): SubsystemCli.RunTermination {
  if (result.termination) return result.termination
  if (result.timedOut) return "budget_exhausted"
  if (result.exitCode === 127) return "spawn_failed"
  return result.exitCode === 0 ? "completed" : "subsystem_failed"
}

// ── One Primary Failure Owns The Terminal Explanation ────────────
// A provider error often causes missing output and handoff evidence downstream.
// Rendering every consequence as an equal warning obscures the initiating fault.
// This classifier therefore selects one stable, redacted cause in causal order;
// remaining cleanup and validation diagnostics stay as secondary warnings.
// Orchestration and the TUI consume this field instead of inferring severity from
// warning text or an otherwise successful process exit.
// ─────────────────────────────────────────────────────────────────
function phaseFailure(input: {
  readonly spec: PhaseSpec
  readonly run: SubsystemCli.RunResult
  readonly termination: SubsystemCli.RunTermination
  readonly deliverable?: string
  readonly deliverableExists: boolean
  readonly manifestWarning?: string
  readonly gatewayExited: boolean
  readonly handoffWarning?: string
  readonly readinessWarning?: string
  readonly summary: string
}): PhaseFailure | undefined {
  const provider = input.run.failure
  if (provider)
    return {
      phase: input.spec.phase,
      source: "provider",
      class: provider.kind,
      ...(provider.providerCode ? { code: provider.providerCode } : {}),
      detail: provider.detail ?? `The configured provider ended the phase with ${provider.kind}.`,
    }
  if (!input.deliverableExists && input.deliverable)
    return {
      phase: input.spec.phase,
      source: "contract",
      class: "required_deliverable_missing",
      code: input.deliverable,
      detail: `Required deliverable '${input.deliverable}' is missing.`,
    }
  if (input.manifestWarning)
    return {
      phase: input.spec.phase,
      source: "lifecycle",
      class: "artifact_manifest_failed",
      detail: input.manifestWarning,
    }
  if (!input.gatewayExited)
    return {
      phase: input.spec.phase,
      source: "lifecycle",
      class: "gateway_exit_unverified",
      detail: "The phase gateway did not exit cleanly, so no successor may start.",
    }
  if (input.handoffWarning)
    return {
      phase: input.spec.phase,
      source: "contract",
      class: "handoff_invalid",
      detail: input.handoffWarning,
    }
  if (input.readinessWarning)
    return {
      phase: input.spec.phase,
      source: "contract",
      class: "successor_readiness_failed",
      detail: input.readinessWarning,
    }
  if (
    (input.termination !== "completed" || input.run.exitCode !== 0) &&
    input.termination !== "budget_exhausted" &&
    input.termination !== "shutdown"
  )
    return {
      phase: input.spec.phase,
      source: "lifecycle",
      class: input.termination,
      code: String(input.run.exitCode),
      detail: input.run.failureReason ?? `The phase runtime exited with code ${input.run.exitCode}.`,
    }
  if (!input.summary.trim())
    return {
      phase: input.spec.phase,
      source: "contract",
      class: "summary_missing",
      detail: "The phase returned no final summary.",
    }
}

function statusTranscript(stdout: string, result: PhaseResult): string {
  const status = JSON.stringify({
    type: "cyberful.phase.status",
    phase: result.phase,
    ok: result.ok,
    termination: result.termination,
    backend: result.backend,
    durationMs: result.durationMs,
    limitMs: result.limitMs,
    effectiveLimitMs: result.effectiveLimitMs,
    deadlineAt: result.deadlineAt,
    approvalWaitMs: result.approvalWaitMs,
    exitCode: result.exitCode,
    subsystemFailure: result.subsystemFailure,
    phaseFailure: result.phaseFailure,
    warnings: result.warnings,
    handoff: result.handoff
      ? {
          successor: result.handoff.successor,
          artifact: result.handoff.artifact,
          verdicts: result.handoff.verdicts ? SubsystemVerdict.counts(result.handoff.verdicts) : undefined,
        }
      : undefined,
    usage: result.usage,
    contextChurn: result.contextChurn,
    reasoningObservability: result.reasoningObservability,
    agentRun: result.agentRun,
    noveltyContract: result.noveltyContract,
    artifactManifest: result.artifactManifest,
    runtimeManifest: result.runtimeManifest,
  })
  return `${stdout}${stdout && !stdout.endsWith("\n") ? "\n" : ""}${status}\n`
}

export async function persistStatusOnly(
  spec: PhaseSpec,
  result: PhaseResult,
  deps: PhaseDeps = defaultDeps(),
): Promise<void> {
  const runtimeManifest = deps.writeRuntimeManifest
  if (runtimeManifest) {
    const manifestPath = runtimeManifestPath(spec)
    const warning = await operationWarning("Could not persist the phase runtime manifest", () =>
      runtimeManifest(manifestPath, spec.workareaCwd, result),
    )
    if (warning) result.warnings.push(warning)
    else result.runtimeManifest = path.relative(spec.workareaCwd, manifestPath)
  }
  const transcriptPath = spec.transcriptPath
  const createTranscript = deps.createTranscript
  if (!transcriptPath || !createTranscript) return
  const warning = await operationWarning("Could not persist the phase status transcript", async () => {
    const transcript = await createTranscript(transcriptPath)
    await transcript.append(statusTranscript("", result))
    await transcript.close()
  })
  if (warning) result.warnings.push(warning)
}

function failedBeforeSpawn(input: {
  spec: PhaseSpec
  deps: PhaseDeps
  startedAt: number
  limitMs: number
  effectiveLimitMs: number
  deadlineAt: number
  termination: "budget_exhausted" | "spawn_failed"
  detail: string
  budgetWarnings: string[]
}): PhaseResult {
  return {
    phase: input.spec.phase,
    ok: false,
    summary: "",
    exitCode: input.termination === "spawn_failed" ? 127 : 128,
    timedOut: input.termination === "budget_exhausted",
    termination: input.termination,
    backend: input.deps.subsystem.name,
    durationMs: Math.max(0, (input.deps.now ?? Date.now)() - input.startedAt),
    limitMs: input.limitMs,
    effectiveLimitMs: input.effectiveLimitMs,
    deadlineAt: input.deadlineAt,
    warnings: [...input.budgetWarnings],
    ...(input.termination === "spawn_failed"
      ? {
          phaseFailure: {
            phase: input.spec.phase,
            source: "lifecycle",
            class: "phase_setup_failed",
            code: "127",
            detail: input.detail,
          } satisfies PhaseFailure,
        }
      : {}),
  }
}

const WORKAREA_INSTRUCTIONS = [
  "The workarea root is intentionally an artifact workspace, not a Git repository.",
  "Do not run repository-level Git probes such as `git status`, `git diff`, or `git rev-parse` there; inspect artifacts directly with filesystem commands.",
  "Use Git only when a phase explicitly materializes a nested repository or disposable lab, and run it with that repository's explicit working directory.",
  "When working with imported source code, use the host's native shell only for static-analysis operations such as `rg`, `sed`, `find`, and read-only Git queries. The host shell remains available for all other purposes, including networking and scripts that do not execute or load imported source.",
  "For dependency installation, package managers, builds, tests, scripts, binaries, services, or any other execution of imported source, call the cyberful-os `shell` MCP tool, displayed as `cyberful-os_shell`.",
  "The active workarea root is mounted inside cyberful-os at `/workspace`. Map a workarea-relative host path such as `relative/path` to `/workspace/relative/path`; never embed or guess an absolute host workarea path.",
  "Network access remains available inside cyberful-os and may be used for dependency installation and target traffic authorized by `MISSION.md`.",
  "If cyberful-os cannot execute imported source, diagnose that environment or record the blocker; do not fall back to executing imported source on the host.",
].join("\n")

// ── Prompt Sources Resolve Before The Worker Starts ──────────────
// First-party policy always supplies the base template. A persona override may
// come only from an explicit trusted settings root and retains the canonical
// workflow-scoped identity; missing overrides fall back to the embedded persona.
// The provider-neutral compiler later renders every source exactly once.
//
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────
async function loadPhasePromptSources(
  spec: PhaseSpec,
  settings: Settings.Info,
  read: PhaseDeps["readFile"],
) {
  const workflow = spec.workflow ?? SubsystemPhase.workflowOf(spec.phase)
  if (!workflow) throw new Error(`cannot resolve workflow for phase '${spec.phase}'`)
  const builtinPersonaPath = SubsystemPhase.personaPath(spec.home, spec.phase, workflow)
  const personaID = `${path.basename(path.dirname(builtinPersonaPath))}/${path.basename(
    builtinPersonaPath,
    path.extname(builtinPersonaPath),
  )}`
  const settingsDirectory = spec.settingsDirectory ?? process.cwd()
  let personaPath = builtinPersonaPath
  let personaSource: string | undefined
  for (const configuredRoot of settings.instructions.persona_roots) {
    const root = path.resolve(settingsDirectory, configuredRoot)
    for (const candidate of [
      path.join(root, `${personaID}.md`),
      path.join(root, "agents", `${personaID}.md`),
    ]) {
      try {
        personaSource = await read(candidate)
        personaPath = candidate
        break
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error
      }
    }
    if (personaSource !== undefined) break
  }
  const [templateSource, fallbackPersona] = await Promise.all([
    read(SubsystemPhase.baseInstructionsPath(spec.home)),
    personaSource === undefined ? read(builtinPersonaPath) : Promise.resolve(undefined),
  ])
  return {
    workflow,
    personaID,
    personaPath,
    templateSource,
    personaSource: personaSource ?? fallbackPersona ?? "",
  }
}

export async function runPhase(spec: PhaseSpec, deps: PhaseDeps = defaultDeps()): Promise<PhaseResult> {
  const now = deps.now ?? Date.now
  const removeDirectory = deps.removeDirectory
  const removeFile = deps.removeFile
  const defaultMinutes = spec.timeoutMs > 0 ? spec.timeoutMs / 60_000 : SubsystemPhase.DEFAULT_PHASE_BUDGET_MINUTES
  const budget = await readBudget(deps.readFile, SubsystemPhase.budgetsPath(spec.home), spec.phase, defaultMinutes)
  const limitMs = Math.round(budget.minutes * 60_000)
  const budgetWarnings = [budget.warning, budget.noveltyWarning].filter((item): item is string => Boolean(item))
  const beforeSetup = now()
  const initialDeadline = beforeSetup + limitMs
  const initialEffectiveLimitMs = limitMs

  const promptSetup = await (async () => {
    const settingsDirectory = spec.settingsDirectory ?? process.cwd()
    const settings = await deps.loadSettings(settingsDirectory)
    const sources = await loadPhasePromptSources(spec, settings, deps.readFile)
    const configuredSkillRoots = settings.instructions.skill_roots.map((root) =>
      path.resolve(settingsDirectory, root),
    )
    const skills = await deps.discoverSkills([SubsystemPhase.skillRoot(spec.home), ...configuredSkillRoots])
    return { settings, sources, skills }
  })().then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  )
  if (!promptSetup.ok) {
    const result = failedBeforeSpawn({
      spec,
      deps,
      startedAt: beforeSetup,
      limitMs,
      effectiveLimitMs: initialEffectiveLimitMs,
      deadlineAt: initialDeadline,
      termination: "spawn_failed",
      detail: `Phase setup failed: could not compile Pi runtime inputs: ${
        promptSetup.error instanceof Error ? promptSetup.error.message : String(promptSetup.error)
      }`,
      budgetWarnings,
    })
    await persistStatusOnly(spec, result, deps)
    return result
  }

  const safeRunKey = spec.sessionID.replace(/[^a-zA-Z0-9_.-]/g, "-")
  // Signal files outlive their subprocess briefly, so every attempt gets a nonce. A gateway from a timed-out
  // attempt can never write into a retried phase's handoff or PID path.
  const signalKey = `${safeRunKey}-${process.pid}-${randomUUID()}`
  const handoffPath = spec.handoff ? path.join(os.tmpdir(), `expert-phase-handoff-${signalKey}.json`) : undefined
  const gatewayPidPath = path.join(os.tmpdir(), `expert-phase-gateway-pid-${signalKey}.json`)
  const approvalState = SubsystemApprovalState.create()
  const questionHandler = deps.askQuestion
  const askQuestion: AskHuman | undefined = questionHandler
    ? (questions, signal) => approvalState.wait(() => questionHandler(questions, signal))
    : undefined
  const shellTemporaryDirectory = path.join(spec.workareaCwd, ".cyberful-tmp")
  const engagementCircuitBreakerPath = circuitBreakerPath(spec.sessionID, "engagement")
  // The host exposes one explicit gateway connection while its private environment remains outside
  // AgentRun context. Phase handoff uses a fresh host-owned signal path so a stale
  // request from an interrupted run can never advance a later run.
  const gatewayOptions: SubsystemGateway.GatewayOptions = {
    proxy: true,
    phase: spec.phase,
    env: {
      ...spec.env,
      CYBERFUL_SUBSYSTEM_WORKAREA_ROOT: spec.workareaCwd,
      CYBERFUL_SUBSYSTEM_LABEL: spec.phase,
      ...(spec.transcriptPath ? { CYBERFUL_SUBSYSTEM_SESSION_LOG_ROOT: path.dirname(spec.transcriptPath) } : {}),
      ...(spec.workflow ? { CYBERFUL_SUBSYSTEM_WORKFLOW: spec.workflow } : {}),
      ...(budget.novelty ? { [SubsystemNovelty.CONTRACT_ENV]: JSON.stringify(budget.novelty) } : {}),
      ...(spec.sourceRoot ? { CYBERFUL_SUBSYSTEM_SOURCE_ROOT: spec.sourceRoot } : {}),
    },
    pidSignalPath: gatewayPidPath,
    questionEnabled: Boolean(askQuestion),
    circuitBreakerPath: engagementCircuitBreakerPath,
    ...(handoffPath
      ? {
          handoff: {
            phase: spec.phase,
            successor: spec.handoff?.successor,
            signalPath: handoffPath,
            artifact: phaseDeliverable(spec),
          },
        }
      : {}),
  }
  const mcpServer = SubsystemGateway.gatewayMcpServer(spec.sessionID, gatewayOptions)
  try {
    await deps.ensureDirectory(shellTemporaryDirectory)
    if (handoffPath) await deps.removeFile?.(handoffPath)
    await deps.removeFile?.(gatewayPidPath)
  } catch (error) {
    const setupCleanupWarning = await operationWarning(
      "Could not remove the phase runtime directory after setup failed",
      removeDirectory ? () => removeDirectory(shellTemporaryDirectory) : undefined,
    )
    const result = failedBeforeSpawn({
      spec,
      deps,
      startedAt: beforeSetup,
      limitMs,
      effectiveLimitMs: initialEffectiveLimitMs,
      deadlineAt: initialDeadline,
      termination: "spawn_failed",
      detail: `Phase setup failed: ${error instanceof Error ? error.message : String(error)}`,
      budgetWarnings,
    })
    if (setupCleanupWarning) result.warnings.push(setupCleanupWarning)
    await persistStatusOnly(spec, result, deps)
    return result
  }

  // Setup time counts against the phase budget, so the AgentRun receives only the remaining active-execution allowance.
  const startedAt = now()
  const deadlineAt = initialDeadline
  const effectiveLimitMs = Math.max(0, deadlineAt - startedAt)
  if (effectiveLimitMs <= 0) {
    const result = failedBeforeSpawn({
      spec,
      deps,
      startedAt,
      limitMs,
      effectiveLimitMs,
      deadlineAt,
      termination: "budget_exhausted",
      detail: "The phase budget elapsed during setup.",
      budgetWarnings,
    })
    result.warnings.push(
      ...(await operationWarnings([
        [
          "Could not remove the phase runtime directory after setup exhausted the budget",
          removeDirectory ? () => removeDirectory(shellTemporaryDirectory) : undefined,
        ],
      ])),
    )
    await persistStatusOnly(spec, result, deps)
    return result
  }

  const onActivity = deps.onActivity
  const phaseUsage = SubsystemUsage.createSessionCounter()
  const primaryUsageRun = {}
  const reasoningItems = new Set<string>()
  const reasoningSummaryItems = new Set<string>()
  const reasoningContentItems = new Set<string>()
  const reasoningDeltaItems = new Set<string>()
  const observeActivity = (run: object, activity: Subsystem.PhaseActivity): void => {
    if (activity.kind === "progress") phaseUsage.observe(run, activity.usage)
    if (activity.kind === "reasoning") {
      reasoningItems.add(activity.itemID)
      if (activity.hasSummary) reasoningSummaryItems.add(activity.itemID)
      if (activity.hasContent) reasoningContentItems.add(activity.itemID)
      if (activity.hasDelta) reasoningDeltaItems.add(activity.itemID)
    }
    onActivity?.(activity)
  }
  const semanticArtifact = phaseDeliverable(spec)
  let semanticHash: string | undefined
  let semanticCheckpoints = 0
  let lastSemanticProgressAt: number | undefined
  let semanticCheckpointWarning: string | undefined
  let checkpointQueue = Promise.resolve()
  const writeArtifactCheckpoint = deps.writeArtifactCheckpoint
  // ── Semantic Checkpoints Have One Serialized Owner ──────────────────
  // Subsystem events are synchronous observations, while checkpoint writes are
  // asynchronous filesystem replacements that can overlap when events arrive
  // quickly. One phase-owned promise tail serializes those writes and retains
  // their latest warning without failing the subsystem turn for a transiently
  // absent artifact. The phase awaits that owner before reading its final state,
  // so no checkpoint write survives cleanup or disappears as floating work.
  // ───────────────────────────────────────────────────────────────
  const queueSemanticProgressCapture = (): void => {
    if (!semanticArtifact || !writeArtifactCheckpoint) return
    checkpointQueue = checkpointQueue
      .then(async () => {
        const checkpoint = artifactCheckpointPath(spec)
        const sha256 = await writeArtifactCheckpoint(checkpoint, path.join(spec.workareaCwd, semanticArtifact))
        semanticCheckpointWarning = undefined
        if (sha256 === semanticHash) return
        semanticHash = sha256
        semanticCheckpoints += 1
        lastSemanticProgressAt = now()
        deps.onSemanticProgress?.({
          phase: spec.phase,
          artifact: semanticArtifact,
          checkpoint: path.relative(spec.workareaCwd, checkpoint),
          sha256,
          count: semanticCheckpoints,
          timestamp: lastSemanticProgressAt,
        })
      })
      // A deliverable may not exist yet or may be between an application's unlink-and-rename steps. The
      // previous checkpoint remains valid; a later activity retries without failing the phase.
      .catch((error) => {
        semanticCheckpointWarning = `Could not capture the latest artifact checkpoint: ${errorDetail(error)}`
      })
  }
  // ── Transcript Persistence Is Incremental And Phase-Owned ──────
  // A multi-hour phase can produce megabytes of AgentEvents before its terminal
  // result. Retaining those lines in memory and rewriting them only at shutdown
  // made live diagnosis impossible and amplified failure paths. The phase opens
  // one private writer before the AgentRun starts; the runtime serially appends
  // each already-redacted event, while the host appends its terminal status and
  // closes the resource after all validation is complete.
  // ─────────────────────────────────────────────────────────────────
  const transcriptPath = spec.transcriptPath
  const transcriptAttempt =
    transcriptPath && deps.createTranscript
      ? await deps.createTranscript(transcriptPath).then(
          (writer) => ({ writer, warning: undefined }),
          (error) => ({
            writer: undefined,
            warning: `Could not create the phase transcript: ${errorDetail(error)}`,
          }),
        )
      : { writer: undefined, warning: undefined }
  const transcript = transcriptAttempt.writer
  const stream = Boolean(onActivity) || Boolean(transcript)
  const runtimeInstructions = buildPhasePrompt(
    spec,
    Number((effectiveLimitMs / 60_000).toFixed(2)),
    budget.novelty,
  )
  const compilePrompt = (
    role: "root" | "subagent" | "fallback",
    providerRoute: "main" | "fallback",
    userTask: string,
    handoffOwner: boolean,
  ) =>
    AgentPromptCompiler.compile({
      templateSource: promptSetup.value.sources.templateSource,
      personaSource: promptSetup.value.sources.personaSource,
      workareaSource: WORKAREA_INSTRUCTIONS,
      runtimeInstructions,
      workflow: promptSetup.value.sources.workflow,
      phase: spec.phase,
      personaID: promptSetup.value.sources.personaID,
      role,
      providerRoute,
      handoffOwner,
      delegationEnabled: promptSetup.value.settings.agent.subagents.enabled,
      fallback: {
        providerConfigured: Boolean(promptSetup.value.settings.agent.fallback_provider),
        proactiveEnabled: promptSetup.value.settings.agent.fallback.proactive.enabled,
        proactivePercentage: promptSetup.value.settings.agent.fallback.proactive.percentage,
        automaticSecurityBlockEnabled:
          promptSetup.value.settings.agent.fallback.automatic_security_block.enabled,
      },
      userTask,
      skills: promptSetup.value.skills.catalog,
    })
  const rootPrompt = compilePrompt("root", "main", spec.objective, Boolean(spec.handoff))
  const runInput: SubsystemCli.RunInput = {
    settings: promptSetup.value.settings,
    sessionID: spec.sessionID,
    workarea: spec.workareaCwd,
    gateway: mcpServer,
    prompt: spec.objective,
    compiledPrompt: rootPrompt,
    compileChildPrompt: (input) =>
      compilePrompt(
        input.role,
        input.providerRoute,
        SubsystemPiAgent.formatTaskCapsule(input.task),
        false,
      ),
    task: {
      objective: spec.objective,
      ...(semanticArtifact ? { artifacts: [semanticArtifact] } : {}),
    },
    skills: promptSetup.value.skills,
    dynamicTools: deps.dynamicTools,
    deadlineAt,
    abort: spec.abort,
    timeoutMs: effectiveLimitMs,
    askQuestion,
    approvalState,
    handoffOwner: Boolean(spec.handoff),
    transcript,
    spec: {
      cwd: spec.workareaCwd,
      permission: { kind: "autonomous" },
      networkAccess: spec.workflow !== "code-audit",
      mcpServer,
      baseInstructions: rootPrompt.system,
      skillRoots: [SubsystemPhase.skillRoot(spec.home), ...promptSetup.value.settings.instructions.skill_roots],
      markdownArtifacts:
        semanticArtifact && /\.(?:md|markdown)$/i.test(semanticArtifact) ? [semanticArtifact] : [],
    },
  }

  queueSemanticProgressCapture()
  await checkpointQueue
  const projectActivityActor = Subsystem.createActivityActorProjection()

  // Streaming forwards activity to the live observer while Pi appends every
  // complete redacted event through the phase-owned transcript writer. The
  // terminal AgentRun result remains the authoritative summary in either mode.
  const primaryRun = await (
    stream
      ? deps.runStreaming(runInput, (event) => {
          queueSemanticProgressCapture()
          for (const activity of deps.subsystem.streamActivities(event)) {
            const projected = projectActivityActor(activity)
            if (projected) observeActivity(primaryUsageRun, projected)
          }
        })
      : deps.run(runInput)
  ).catch(
    (error): SubsystemCli.RunResult => ({
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 127,
      timedOut: false,
      termination: "spawn_failed",
    }),
  )
  queueSemanticProgressCapture()
  await checkpointQueue
  const approvalWaitMs = Math.round(approvalState.pausedMs())
  const primaryTermination = processTermination(primaryRun)
  // The runtime promise resolves only after the phase-scoped Pi subsystem has closed its bridge. Gateway
  // upstreams may live in another process group, so reap it and prove it is gone before validating handoff.
  const gatewayExit =
    primaryTermination === "spawn_failed" || !deps.waitForGatewayExit
      ? ({ exited: true, warning: undefined } as const)
      : await deps.waitForGatewayExit(gatewayPidPath, 5_000, Boolean(spec.handoff)).then(
          (exited) => ({ exited, warning: undefined }),
          (error) => ({
            exited: false,
            warning: `Could not verify phase gateway shutdown: ${errorDetail(error)}`,
          }),
        )
  const primaryGatewayExited = gatewayExit.exited
  const lifecycleWarnings: string[] = []
  const primaryHandoff = handoffPath
    ? await readHandoff(deps.readFile, handoffPath, spec)
    : ({ value: undefined, warning: undefined, missing: false } as const)
  lifecycleWarnings.push(
    ...(await operationWarnings([
      [
        "Could not remove the phase handoff signal",
        handoffPath && removeFile ? () => removeFile(handoffPath) : undefined,
      ],
      ["Could not remove the phase gateway PID signal", removeFile ? () => removeFile(gatewayPidPath) : undefined],
    ])),
  )
  const primarySummary = primaryRun.agentResult?.output ?? deps.subsystem.extractResultText(primaryRun.stdout)
  const deliverable = phaseDeliverable(spec)
  const inspectDeliverable = async (): Promise<{ exists: boolean; warning?: string }> =>
    deliverable && deps.fileExists
      ? deps.fileExists(path.join(spec.workareaCwd, deliverable)).then(
          (exists) => ({ exists }),
          (error) => ({
            exists: false,
            warning: `Could not inspect the required deliverable '${deliverable}': ${errorDetail(error)}`,
          }),
        )
      : { exists: true }
  const deliverableCheck = await inspectDeliverable()
  const rawTermination = primaryTermination
  const gatewayExited = primaryGatewayExited
  const handoff = primaryHandoff
  const subsystemSummary = primarySummary
  const deliverableExists = deliverableCheck.exists
  // REPORT.md is intentionally finalized later by the host's variable-resolution/PDF boundary. Its
  // manifest is written there; hashing it here would become stale after that authorized host mutation.
  const manifest =
    deliverable && deliverableExists && spec.phase !== "report" && deps.writeArtifactManifest
      ? {
          path: artifactManifestPath(spec),
          artifact: path.join(spec.workareaCwd, deliverable),
          write: deps.writeArtifactManifest,
        }
      : undefined
  const manifestWarning = manifest
    ? await manifest
        .write(manifest.path, manifest.artifact)
        .then(() => undefined)
        .catch(
          (error) =>
            `Could not write the final artifact manifest: ${error instanceof Error ? error.message : String(error)}`,
        )
    : undefined
  const runtimeCleanupWarning = await operationWarning(
    "Could not remove the phase runtime directory",
    removeDirectory ? () => removeDirectory(shellTemporaryDirectory) : undefined,
  )

  // ── A Budget Cutoff Advances Only A Sealed Partial Artifact ────────
  // Active-execution exhaustion is an expected scheduler boundary, not a request to
  // leave the workflow parked forever. If the cutoff arrives before the model's
  // handoff, the host may synthesize that record only after the required artifact
  // exists, its manifest is sealed, and the private gateway is proven gone.
  // Malformed handoffs and failed artifact or lifecycle gates still fail closed.
  // The successor receives an explicit degraded summary and must treat unfinished
  // coverage as partial rather than silently assuming phase completeness.
  //
  // @docs/concepts/execution-model.md
  // ─────────────────────────────────────────────────────────────────
  const canSynthesizeBudgetHandoff =
    rawTermination === "budget_exhausted" &&
    spec.handoff !== undefined &&
    handoff.missing &&
    deliverable !== undefined &&
    deliverableExists &&
    !manifestWarning &&
    gatewayExited
  const synthesizedHandoff: PhaseHandoff | undefined = canSynthesizeBudgetHandoff
    ? {
        phase: spec.phase,
        successor: spec.handoff?.successor,
        summary: [
          `The ${spec.phase} phase exhausted its active-execution budget. Continue from the sealed partial deliverable '${deliverable}' and treat unfinished coverage as degraded.`,
          subsystemSummary.trim(),
        ]
          .filter(Boolean)
          .join("\n\n"),
        artifact: deliverable,
      }
    : undefined
  const acceptedHandoff = handoff.value ?? synthesizedHandoff
  const handoffWarning = synthesizedHandoff ? undefined : handoff.warning
  const summary = acceptedHandoff?.summary ?? subsystemSummary
  const readinessRequired =
    spec.workflow === "code-audit" && spec.phase === "index" && acceptedHandoff?.successor === "trace"
  const readinessWarning = readinessRequired
    ? !gatewayExited
      ? "Code Audit index readiness was not evaluated because the phase gateway is still live; trace is blocked."
      : deps.verifyCodeGraphReadiness
        ? await deps
            .verifyCodeGraphReadiness({
              ...spec.env,
              CYBERFUL_SUBSYSTEM_WORKAREA_ROOT: spec.workareaCwd,
              ...(spec.workflow ? { CYBERFUL_SUBSYSTEM_WORKFLOW: spec.workflow } : {}),
              ...(spec.sourceRoot ? { CYBERFUL_SUBSYSTEM_SOURCE_ROOT: spec.sourceRoot } : {}),
            })
            .then(() => undefined)
            .catch((error) => `Code Audit index readiness failed; trace is blocked: ${errorDetail(error)}`)
        : "Code Audit index readiness verifier is unavailable; trace is blocked."
    : undefined
  const budgetAdvanceWarning =
    rawTermination === "budget_exhausted" &&
    acceptedHandoff &&
    deliverable !== undefined &&
    deliverableExists &&
    !manifestWarning &&
    gatewayExited
      ? synthesizedHandoff
        ? `Phase budget exhausted before an explicit handoff; advancing with sealed partial deliverable '${deliverable}'.`
        : `Phase budget exhausted after a valid handoff; advancing with sealed deliverable '${deliverable}'.`
      : undefined
  const ok =
    ((rawTermination === "completed" && primaryRun.exitCode === 0) ||
      (rawTermination === "budget_exhausted" && spec.handoff !== undefined && acceptedHandoff !== undefined)) &&
    summary.trim().length > 0 &&
    deliverableExists &&
    !manifestWarning &&
    gatewayExited &&
    !handoffWarning &&
    !readinessWarning
  const primaryFailure = ok
    ? undefined
    : phaseFailure({
        spec,
        run: primaryRun,
        termination: rawTermination,
        deliverable,
        deliverableExists,
        manifestWarning,
        gatewayExited,
        handoffWarning,
        readinessWarning,
        summary,
      })
  const warnings = [
    ...budgetWarnings,
    ...(transcriptAttempt.warning ? [transcriptAttempt.warning] : []),
    ...(deliverableCheck.warning && primaryFailure?.class !== "required_deliverable_missing"
      ? [deliverableCheck.warning]
      : []),
    ...(runtimeCleanupWarning ? [runtimeCleanupWarning] : []),
    ...(semanticCheckpointWarning ? [semanticCheckpointWarning] : []),
    ...lifecycleWarnings,
    ...(gatewayExit.warning && primaryFailure?.class !== "gateway_exit_unverified" ? [gatewayExit.warning] : []),
    ...(budgetAdvanceWarning ? [budgetAdvanceWarning] : []),
  ]
  const observedUsage = phaseUsage.usage()
  const hasObservedUsage =
    observedUsage.input > 0 ||
    observedUsage.output > 0 ||
    observedUsage.reasoning > 0 ||
    observedUsage.cache.read > 0 ||
    observedUsage.cache.write > 0
  const result: PhaseResult = {
    phase: spec.phase,
    ok,
    summary,
    exitCode: primaryRun.exitCode,
    timedOut: rawTermination === "budget_exhausted",
    termination: rawTermination === "completed" ? (ok ? "completed" : "subsystem_failed") : rawTermination,
    backend: deps.subsystem.name,
    durationMs: Math.max(0, now() - startedAt - approvalWaitMs),
    limitMs,
    effectiveLimitMs,
    deadlineAt: deadlineAt + approvalWaitMs,
    approvalWaitMs,
    warnings,
    handoff: acceptedHandoff,
    artifactManifest: manifest && !manifestWarning ? path.relative(spec.workareaCwd, manifest.path) : undefined,
    semanticCheckpoints: semanticCheckpoints || undefined,
    lastSemanticProgressAt,
    subsystemFailure: primaryRun.failure,
    phaseFailure: primaryFailure,
    usage: hasObservedUsage ? observedUsage : undefined,
    contextChurn: hasObservedUsage ? SubsystemUsage.contextChurn(observedUsage) : undefined,
    reasoningObservability: {
      items: reasoningItems.size,
      summaryItems: reasoningSummaryItems.size,
      contentItems: reasoningContentItems.size,
      deltaItems: reasoningDeltaItems.size,
      textStatus:
        reasoningSummaryItems.size > 0 || reasoningContentItems.size > 0 || reasoningDeltaItems.size > 0
          ? "published"
          : observedUsage.reasoning > 0 || reasoningItems.size > 0
            ? "only counters received"
            : "no reasoning observed",
    },
    ...(primaryRun.agentResult
      ? {
          agentRun: {
            id: primaryRun.agentResult.id,
            provider: primaryRun.agentResult.provider,
            model: primaryRun.agentResult.model,
            providerAffinity: primaryRun.agentResult.providerAffinity,
            promptManifest: primaryRun.agentResult.promptManifest,
            childRunIDs: primaryRun.agentResult.childRunIDs,
            skillsUsed: primaryRun.agentResult.skillsUsed,
            toolCalls: primaryRun.agentResult.toolCalls,
            fallbackAdmissions: primaryRun.agentResult.fallbackAdmissions,
            fallbackDescendants: primaryRun.agentResult.fallbackDescendants,
          },
        }
      : {}),
    noveltyContract: budget.novelty,
  }

  const runtimeManifest = deps.writeRuntimeManifest
  if (runtimeManifest) {
    const manifestPath = runtimeManifestPath(spec)
    const warning = await operationWarning("Could not persist the phase runtime manifest", () =>
      runtimeManifest(manifestPath, spec.workareaCwd, result),
    )
    if (warning) result.warnings.push(warning)
    else result.runtimeManifest = path.relative(spec.workareaCwd, manifestPath)
  }

  // A killed phase retains every subsystem event received before the group kill, followed by one host
  // status record. This makes a partial excursion auditable without placing stderr or secrets on the bus.
  if (transcript) {
    const transcriptWarning = await operationWarning("Could not persist the phase transcript", async () => {
      await transcript.append(statusTranscript("", result))
      await transcript.close()
    })
    if (transcriptWarning) result.warnings.push(transcriptWarning)
  }
  if (result.ok && spec.handoff && !spec.handoff.successor && removeDirectory) {
    const breakerWarning = await operationWarning("Could not remove the completed engagement circuit breakers", () =>
      removeDirectory(circuitBreakerDirectory(spec.sessionID)),
    )
    if (breakerWarning) result.warnings.push(breakerWarning)
  }
  return result
}

export * as SubsystemPhaseRunner from "./phase-runner"
