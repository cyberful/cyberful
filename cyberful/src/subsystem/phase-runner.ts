// ── Codex Phase Runner ────────────────────────────────────────────
// Runs one phase with its persona and gateway, then validates process
// exit, required artifact, handoff or budget cutoff, cleanup, and transcript results.
// → cyberful/src/subsystem/phase.ts — supplies workflow policy, capability scope, and paths.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import path from "path"
import os from "os"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { writeFile, readFile, mkdir, access, rm, lstat, open, rename } from "fs/promises"
import { DependencyConfig } from "@/dependency/config"
import { SubsystemCodex } from "./codex"
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

export interface PhaseSpec {
  phase: string
  workflow?: string
  kind?: "workflow" | "interactive"
  sessionID: string
  // The workarea directory; writes are physically jailed here (it is the CLI's cwd).
  workareaCwd: string
  // Read-only project root published only to the private gateway. Codex itself remains jailed to the
  // workarea and must use source tools rather than native writes against this path.
  sourceRoot?: string
  // The configured agents directory holding this phase's persona and settings policy.
  home: string
  // What this phase must accomplish, seeded from the prior handoff.
  objective: string
  model?: string
  timeoutMs: number
  abort?: AbortSignal
  // Absolute file to persist this excursion's raw stream-json transcript to (the caller resolves it,
  // normally beside the session journal via SessionReportLog.expertTranscriptFile). Unset ⇒ no
  // transcript is kept and the phase may take the cheaper buffered path.
  transcriptPath?: string
  // Private environment for the phase gateway and its upstreams. It is deliberately excluded from the
  // Codex process environment: recon routing and ZAP keys are capabilities, not model-readable secrets.
  env?: Record<string, string>
  // Every chain phase must explicitly call the gateway's handoff tool.
  // The host records the request out-of-band, waits for this CLI process to exit, then validates the
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
  // writes it only after the Codex process and gateway are gone, so it cannot race a last agent edit.
  artifactManifest?: string
  // Host-owned runtime provenance; unlike the deliverable checksum this is JSON status evidence.
  runtimeManifest?: string
  // Tool activity is not progress by itself. These fields count only distinct host-observed contents of
  // the required deliverable, each saved as an atomic last-known-good checkpoint while the phase runs.
  semanticCheckpoints?: number
  lastSemanticProgressAt?: number
  subsystemFailure?: SubsystemFailure
  // Subsystem-neutral counters and derived context-reuse metrics cover the phase
  // process and its native children.
  usage?: UsageTotals
  contextChurn?: ContextChurn
  reasoningObservability?: {
    readonly items: number
    readonly summaryItems: number
    readonly contentItems: number
    readonly deltaItems: number
    readonly textStatus: "published" | "only counters received" | "no reasoning observed"
  }
  codexSettings?: {
    readonly requestedEffort: string
    readonly resolvedEffort: string | null
    readonly attested: boolean
    readonly error?: string
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

// Injected so the spawn contract is testable without a live external CLI or real filesystem.
export interface PhaseDeps {
  run: typeof SubsystemCli.run
  runStreaming: typeof SubsystemCli.runStreaming
  subsystem: Subsystem.Subsystem
  command: string
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
  // Production reads the gateway's startup PID, reaps its process group after Codex exits, and proves
  // the group is gone. A handoff phase requires the registration because it necessarily used the gateway.
  waitForGatewayExit?: (signalPath: string, timeoutMs: number, registrationRequired: boolean) => Promise<boolean>
  // When set, the phase streams: the CLI runs in stream-json mode and every activity item mapped from
  // its events (subsystem.streamActivities) is delivered here as it happens, so the TUI shows the phase
  // working live. Unset (the default) runs the CLI buffered.
  onActivity?: (activity: Subsystem.PhaseActivity) => void
  onSemanticProgress?: (progress: SemanticProgress) => void
  // Optional writer for the phase's complete stream-json transcript.
  writeTranscript?: (filePath: string, ndjson: string) => Promise<void>
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
  const runtime = DependencyConfig.expertRuntime()
  return {
    run: SubsystemCli.run,
    runStreaming: SubsystemCli.runStreaming,
    subsystem: Subsystem.codex,
    command: runtime.command,
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
    writeTranscript: async (filePath, ndjson) => {
      await mkdir(path.dirname(filePath), { recursive: true })
      const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, ndjson, { mode: 0o600, flag: "wx" })
        .then(() => rename(temporary, filePath))
        .finally(() => rm(temporary, { force: true }))
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
    codexSettings: result.codexSettings,
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

// Codex may kill an MCP server directly, so an exit-time marker is inherently racy. The gateway instead
// registers its PID at startup. Once the Codex leader has exited, first request a graceful gateway close;
// if any member of its process group survives, group-kill it before returning to the orchestrator.
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

// Frame the phase's task: its objective plus the standing contract every Expert phase honors (work in
// the workarea, persist reusable values as variables, end with a structured summary the next owner
// reads). The phase's detailed playbook arrives separately in Cyberful's rendered base instructions.
export function buildPhasePrompt(spec: PhaseSpec, budgetMinutes: number, novelty?: NoveltyContract): string {
  if (spec.kind === "interactive")
    return [
      `You are running one autonomous Ask turn in the existing Cyberful workarea (${spec.workareaCwd}).`,
      "Use the complete gateway and filesystem capabilities when they improve the answer. Stay inside the",
      "authorized engagement scope, preserve existing evidence, and write reusable results to the workarea.",
      "Do not call handoff. End with the concise Markdown answer that should be shown directly to the user.",
      "",
      "## Request and explicit context",
      spec.objective,
      "",
      "## Time budget",
      `You have up to ${budgetMinutes} minutes for this Ask turn. Finish earlier when the request is complete.`,
    ].join("\n")
  const deliverable = phaseDeliverable(spec)
  const successor = spec.handoff?.successor
  const workflow = spec.workflow ?? SubsystemPhase.workflowOf(spec.phase) ?? "security"
  return [
    `You are running the ${spec.phase} phase of the Cyberful ${workflow} workflow to completion, autonomously.`,
    `Your working directory is the workarea (${spec.workareaCwd}); write all files there.`,
    "",
    "## Objective",
    spec.objective,
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
    codexSettings: result.codexSettings,
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
  const writeTranscript = deps.writeTranscript
  if (!transcriptPath || !writeTranscript || !DependencyConfig.expertTranscriptEnabled()) return
  const warning = await operationWarning("Could not persist the phase status transcript", () =>
    writeTranscript(transcriptPath, statusTranscript("", result)),
  )
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
  warning: string
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
    warnings: [...input.budgetWarnings, input.warning],
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

// ── Dynamic Phase Policy Renders Into One Base Template ─────────
// Stable execution behavior lives in baseInstructions.md, while the selected
// persona, calculated delegation policy, and workarea mechanics fill its three
// reviewed placeholders. The invariant trust boundary is part of the template
// itself. Loading and rendering happen before any process starts, so a missing
// file or malformed template cannot fall back to Codex defaults or a partial
// Cyberful contract.
//
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────
async function loadPhaseBaseInstructions(spec: PhaseSpec, read: PhaseDeps["readFile"]) {
  const paths = [
    SubsystemPhase.baseInstructionsPath(spec.home),
    SubsystemPhase.personaPath(spec.home, spec.phase, spec.workflow),
  ]
  const instructions = await Promise.all(paths.map((filePath) => read(filePath)))
  return SubsystemCodex.composeBaseInstructions(instructions[0] ?? "", instructions[1] ?? "", WORKAREA_INSTRUCTIONS)
}

// ── Package-Manager Scratch State Stays In The Workarea ─────────
// Codex excludes the host temp directory and home from its writable sandbox.
// TMPDIR covers ordinary shell tools, while Bun otherwise keeps using its
// global cache under ~/.bun and reports that denial as a tempdir failure.
// Pin both Bun scratch and cache state beneath the phase-owned temporary root;
// the existing phase finalizer removes the complete tree after the process.
// ─────────────────────────────────────────────────────────────────
function shellRuntimeEnv(temporaryDirectory: string): Record<string, string> {
  return {
    TMPDIR: temporaryDirectory,
    TMPPREFIX: path.join(temporaryDirectory, "zsh"),
    BUN_TMPDIR: temporaryDirectory,
    BUN_INSTALL_CACHE_DIR: path.join(temporaryDirectory, "bun-install-cache"),
    PYTHONDONTWRITEBYTECODE: "1",
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

  const instructionLoad = await loadPhaseBaseInstructions(spec, deps.readFile).then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  )
  if (!instructionLoad.ok) {
    const result = failedBeforeSpawn({
      spec,
      deps,
      startedAt: beforeSetup,
      limitMs,
      effectiveLimitMs: initialEffectiveLimitMs,
      deadlineAt: initialDeadline,
      termination: "spawn_failed",
      warning: `Phase setup failed: could not load base instructions: ${
        instructionLoad.error instanceof Error ? instructionLoad.error.message : String(instructionLoad.error)
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
  // Codex materializes one explicit MCP server. cli.ts moves its private environment into the phase's
  // owner-only temporary home before spawn. Phase handoff uses a fresh host-owned signal path so a stale
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
      ? { handoff: { phase: spec.phase, successor: spec.handoff?.successor, signalPath: handoffPath } }
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
      warning: `Phase setup failed: ${error instanceof Error ? error.message : String(error)}`,
      budgetWarnings,
    })
    if (setupCleanupWarning) result.warnings.push(setupCleanupWarning)
    await persistStatusOnly(spec, result, deps)
    return result
  }

  // Setup time counts against the phase budget, so the process receives only the remaining wall clock.
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
      warning: "The phase budget elapsed during setup.",
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
  const requestedEffort = SubsystemCodex.effort()
  let resolvedEffort: string | null | undefined
  const observeActivity = (run: object, activity: Subsystem.PhaseActivity): void => {
    if (activity.kind === "progress") phaseUsage.observe(run, activity.usage)
    if (activity.kind === "reasoning") {
      reasoningItems.add(activity.itemID)
      if (activity.hasSummary) reasoningSummaryItems.add(activity.itemID)
      if (activity.hasContent) reasoningContentItems.add(activity.itemID)
      if (activity.hasDelta) reasoningDeltaItems.add(activity.itemID)
    }
    if (activity.kind === "tool" && activity.tool === "codex.settings" && isRecord(activity.input)) {
      resolvedEffort = typeof activity.input.effort === "string" ? activity.input.effort : null
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
  // ── Transcript Persistence Selects The Streaming Transport ──────────
  // Only stream-json contains every turn and tool call; buffered JSON contains
  // the final result envelope alone. A configured transcript path therefore
  // selects streaming even when no live TUI observer exists. The same bounded
  // stdout buffer feeds persistence and final-result extraction, so headless and
  // interactive runs retain an identical durable execution record.
  // ──────────────────────────────────────────────────────────────
  const writeTranscript = deps.writeTranscript
  const persist = Boolean(spec.transcriptPath) && Boolean(writeTranscript) && DependencyConfig.expertTranscriptEnabled()
  const stream = Boolean(onActivity) || persist
  const runInput: SubsystemCli.RunInput = {
    subsystem: deps.subsystem,
    command: deps.command,
    prompt: buildPhasePrompt(spec, Number((effectiveLimitMs / 60_000).toFixed(2)), budget.novelty),
    timeoutMs: effectiveLimitMs,
    abort: spec.abort,
    sessionID: spec.sessionID,
    askQuestion,
    approvalState,
    dynamicTools: deps.dynamicTools,
    spec: {
      cwd: spec.workareaCwd,
      permission: { kind: "autonomous" },
      model: spec.model,
      networkAccess: spec.workflow !== "code-audit",
      env: shellRuntimeEnv(shellTemporaryDirectory),
      mcpServer,
      baseInstructions: instructionLoad.value.baseInstructions,
      nativeSubagents: instructionLoad.value.delegationEnabled,
      skillRoots: [SubsystemPhase.skillRoot(spec.home)],
      markdownArtifacts: semanticArtifact && /\.(?:md|markdown)$/i.test(semanticArtifact) ? [semanticArtifact] : [],
      // Stream when a live observer is attached OR when persisting the transcript; otherwise keep the
      // cheaper single-envelope json path. extractResultText unwraps the summary from either format.
      stream,
    },
  }

  queueSemanticProgressCapture()
  await checkpointQueue
  const projectActivityActor = Subsystem.createActivityActorProjection()

  // When streaming, forward each event's activity items to any live observer; the raw stdout is buffered
  // either way, so extractResultText unwraps the phase summary identically — and, when persisting, that
  // same buffered stdout IS the full stream-json transcript written below.
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
  // The CLI promise resolves only after the Codex process has exited. Its explicit MCP gateway lives in
  // another process group, so reap that registered group and prove it is gone before validating handoff.
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
  const primarySummary = deps.subsystem.extractResultText(primaryRun.stdout)
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
  // Wall-clock exhaustion is an expected scheduler boundary, not a request to
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
          `The ${spec.phase} phase exhausted its wall-clock budget. Continue from the sealed partial deliverable '${deliverable}' and treat unfinished coverage as degraded.`,
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
  const warnings = [
    ...budgetWarnings,
    ...(primaryRun.failureReason ? [primaryRun.failureReason] : []),
    ...(primaryRun.exitCode !== 0 ? [`Expert process exited with code ${primaryRun.exitCode}.`] : []),
    ...(!summary.trim() ? ["Expert returned no final summary."] : []),
    ...(!deliverableExists && deliverable ? [`Required deliverable '${deliverable}' is missing.`] : []),
    ...(deliverableCheck.warning ? [deliverableCheck.warning] : []),
    ...(manifestWarning ? [manifestWarning] : []),
    ...(runtimeCleanupWarning ? [runtimeCleanupWarning] : []),
    ...(semanticCheckpointWarning ? [semanticCheckpointWarning] : []),
    ...lifecycleWarnings,
    ...(gatewayExit.warning ? [gatewayExit.warning] : []),
    ...(!gatewayExited ? ["Phase gateway did not exit cleanly; no successor may start."] : []),
    ...(handoffWarning ? [handoffWarning] : []),
    ...(readinessWarning ? [readinessWarning] : []),
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
    codexSettings: {
      requestedEffort,
      resolvedEffort: resolvedEffort ?? null,
      attested: resolvedEffort === requestedEffort,
      ...(resolvedEffort === requestedEffort
        ? {}
        : {
            error: `Codex effort attestation ${resolvedEffort === undefined ? "missing" : `resolved '${resolvedEffort}'`}; expected '${requestedEffort}'.`,
          }),
    },
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
  const transcriptPath = spec.transcriptPath
  if (persist && writeTranscript && transcriptPath) {
    const transcriptWarning = await operationWarning("Could not persist the phase transcript", () =>
      writeTranscript(transcriptPath, statusTranscript(primaryRun.stdout, result)),
    )
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
