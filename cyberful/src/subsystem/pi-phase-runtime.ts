// ── Pi Phase Worker Owner Runtime ────────────────────────────────
// Owns one phase-scoped in-process Pi subsystem, its single MCP connection,
// skill registry, provider registry, event transcript, and deterministic
// shutdown.
// → cyberful/src/subsystem/phase-runner.ts — validates phase completion.
// → cyberful/src/subsystem/runtime-diagnostics.ts — aggregates bounded runtime outcomes.
// ─────────────────────────────────────────────────────────────────

import type { AgentTool } from "@earendil-works/pi-agent-core"
import { createHash, randomUUID } from "node:crypto"
import { Unsafe } from "typebox"
import { Settings } from "@/config/settings"
import type { AgentEvent, AgentRunResult, AgentRunSpec, AgentTaskCapsule, ChildPromptInput } from "./agent-subsystem"
import type { DynamicTool, SubsystemFailure, SubsystemMcpServer } from "./subsystem"
import type { CompiledAgentPrompt } from "./prompt-compiler"
import type { SkillRegistry } from "./pi-skills"
import type { AskHuman } from "./human-question"
import type { Controller as PhaseBudgetClock } from "./phase-budget-clock"
import { PiCredentialStore } from "./pi-credentials"
import { PiAgentSubsystem } from "./pi-agent"
import { durableFallbackLedgerForSession } from "./pi-fallback-ledger"
import { connectPiMcp } from "./pi-mcp"
import { createPiModels } from "./pi-models"
import { PiAudit } from "./pi-audit"
import { replaceWorkareaFile } from "@/workarea"
import { RunStateArtifact } from "./run-state-artifact"
import { PiReasoning } from "./pi-reasoning"
import { ProviderUsageLedger } from "./provider-usage"
import { RuntimeDiagnosticRecorder } from "./runtime-diagnostics"
import { ToolUsageRecorder } from "./gateway/tool-usage"

export type RunTermination = "completed" | "budget_exhausted" | "shutdown" | "spawn_failed" | "subsystem_failed"

export interface RunResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly timedOut: boolean
  readonly termination?: RunTermination
  readonly failureReason?: string
  readonly failure?: SubsystemFailure
  readonly agentResult?: AgentRunResult
}

export interface RunInput {
  readonly settings: Settings.Info
  readonly sessionID: string
  readonly rootRunID?: string
  readonly workarea: string
  readonly gateway: SubsystemMcpServer
  readonly prompt: string
  readonly compiledPrompt: CompiledAgentPrompt
  readonly compileChildPrompt: (input: ChildPromptInput) => CompiledAgentPrompt
  readonly task: AgentTaskCapsule
  readonly skills: SkillRegistry
  readonly dynamicTools?: readonly DynamicTool[]
  readonly deadlineAt: number
  readonly abort?: AbortSignal
  readonly timeoutMs: number
  readonly attempt?: number
  readonly askQuestion?: AskHuman
  readonly budgetClock?: PhaseBudgetClock
  readonly closeoutReserveMs?: number
  readonly handoffOwner: boolean
  readonly providerRoute?: "main" | "fallback"
  readonly transcript?: {
    readonly append: (line: string) => Promise<void>
  }
  readonly spec: {
    readonly cwd: string
    readonly permission: { readonly kind: "autonomous" }
    readonly networkAccess: boolean
    readonly mcpServer: SubsystemMcpServer
    readonly baseInstructions: string
    readonly skillRoots: readonly string[]
    readonly markdownArtifacts: readonly string[]
  }
}

const activeWorkers = new Set<PiAgentSubsystem>()
export const TUI_TOOL_OUTPUT_BYTES = 12 * 1024

function preExecutionToolRoute(tool: string) {
  if (tool === "shell") return { component: "cyberful-os" as const, route: "cyberful-os/shell" }
  if (tool.startsWith("browser_")) return { component: "browser" as const, route: `browser/${tool}` }
  if (tool.startsWith("zap_")) return { component: "zap" as const, route: `zap/${tool}` }
  if (tool.startsWith("ghidra_")) return { component: "ghidra" as const, route: `ghidra/${tool}` }
  return { component: "agent" as const, route: `host/${tool}` }
}

function recordAgentDiagnostic(event: AgentEvent, diagnostics: RuntimeDiagnosticRecorder): void {
  if (
    event.type === "activity" &&
    event.activity.kind === "output" &&
    event.activity.isError === true &&
    event.activity.preExecution === true &&
    event.activity.tool
  ) {
    const route = preExecutionToolRoute(event.activity.tool)
    diagnostics.record({
      ...route,
      runID: event.runID,
      ...(event.activity.actor?.parentID ? { parentRunID: event.activity.actor.parentID } : {}),
      ...(event.activity.actor?.role ? { role: event.activity.actor.role } : {}),
      callID: event.activity.callID,
      server: event.activity.blocked ? "pi-agent/host-policy" : "pi-agent/schema-validation",
      profile: event.activity.tool,
      stage: "tool",
      severity: "error",
      errorClass: event.activity.blocked ? "HostToolPolicyBlock" : "ToolArgumentValidationError",
      code: event.activity.blocked ? "host_policy_block" : "invalid_arguments",
      outcome: "tool_failure",
      blocking: event.activity.blocked,
      message: event.activity.text,
    })
    return
  }
  if (event.type === "recovery") {
    diagnostics.record({
      component: "agent",
      runID: event.runID,
      stage: "provider",
      severity: event.state === "failed" || event.state === "denied" ? "warning" : "info",
      errorClass: "AgentRunRecovery",
      code: event.denialCode ?? event.state,
      outcome: event.state === "completed" ? "recovered_retry" : "lifecycle_info",
      blocking: event.state === "failed" || event.state === "denied",
      message: `Recovery ${event.chainID} ${event.state}: ${event.sourceRoute} -> ${event.destinationRoute ?? "none"}; cause=${event.cause}; bonus_ms=${event.bonusMs}.`,
    })
    return
  }
  if (event.type === "steering") {
    diagnostics.record({
      component: "agent",
      runID: event.runID,
      stage: "provider",
      severity: event.state === "rejected" ? "warning" : "info",
      errorClass: "AgentRunSteering",
      code: event.state,
      outcome: "lifecycle_info",
      blocking: false,
      message: `Steering ${event.steeringID} ${event.state} in ${event.mode} mode${event.reason ? `: ${event.reason}` : "."}`,
    })
    return
  }
  if (event.type === "context_rotation") {
    if (event.state === "started" || event.state === "completed") return
    const blocking = event.state === "failed" && event.reason === "active_tail_too_large"
    diagnostics.record({
      component: "agent",
      profile: event.model,
      stage: "context",
      severity: blocking ? "error" : event.state === "failed" ? "warning" : "info",
      errorClass: "ContextRotation",
      ...(event.reason ? { code: event.reason } : {}),
      outcome: event.reason === "active_tail_too_large" ? "capacity_failure" : "context_rotation",
      blocking,
      message: [
        `Context rotation ${event.state}.`,
        `before=${event.estimatedTokensBefore}`,
        `after=${event.estimatedTokensAfter}`,
        `target=${event.limits.targetTokens}`,
        `hard=${event.limits.hardInputTokens}`,
        `summarized=${event.summarizedMessages}`,
      ].join(" "),
    })
    return
  }
  if (event.type === "provider_retry") {
    const terminalFailure = event.state === "timed_out" || event.state === "exhausted"
    const failedGeneration = event.state === "scheduled"
    diagnostics.record({
      component: "agent",
      runID: event.runID,
      profile: event.failure?.kind ?? "provider",
      stage: "provider",
      severity: terminalFailure ? "error" : failedGeneration ? "warning" : "info",
      errorClass: "ProviderRetry",
      code: event.failure?.providerCode ?? event.state,
      outcome: event.state === "succeeded" ? "recovered_retry" : event.state === "scheduled" ? "runtime_failure" : "lifecycle_info",
      blocking: terminalFailure,
      message: `Provider retry ${event.state} at attempt ${event.attempt}/${event.maxRetries}${
        event.failure?.providerCode ? ` after provider code ${event.failure.providerCode}` : ""
      }.`,
    })
    return
  }
  if (event.type !== "run_finished" || event.termination === "completed") return
  const profile = event.failure?.kind ?? event.termination
  const code = event.failure?.providerCode ?? event.termination
  diagnostics.record({
    component: "agent",
    runID: event.runID,
    ...(event.parentID ? { parentRunID: event.parentID } : {}),
    role: event.role,
    termination: event.termination,
    terminationCause: event.terminationCause,
    profile,
    stage: "provider",
    severity: "error",
    errorClass: "AgentRunFailure",
    code,
    outcome: event.failure?.kind === "capacity" ? "capacity_failure" : "runtime_failure",
    blocking: event.role === "root",
    message: `AgentRun terminated with ${profile}${
      event.failure?.providerCode ? ` (${event.failure.providerCode})` : ""
    }.`,
  })
}

function emitObservabilityFailure(
  onEvent: ((event: AgentEvent) => void) | undefined,
  runID: string,
  code: string,
  error: unknown,
): void {
  onEvent?.({
    type: "activity",
    runID,
    activity: {
      kind: "status",
      text: JSON.stringify({
        runtimeDiagnostic: {
          component: "phase",
          stage: "shutdown",
          severity: "error",
          errorClass: error instanceof Error ? error.name || "Error" : "Error",
          code,
          outcome: "degraded_observability",
          blocking: false,
        },
      }),
    },
  })
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function dynamicAgentTool(tool: DynamicTool): AgentTool & { readonly deferLoading: boolean } {
  return {
    name: tool.definition.name,
    label: tool.definition.name,
    description: tool.definition.description,
    parameters: Unsafe(tool.definition.inputSchema),
    deferLoading: tool.definition.deferLoading ?? true,
    execute: async (_callID, input, signal) => {
      const result = await tool.execute(input, { signal: signal ?? new AbortController().signal })
      if (!result.success) throw new Error(result.text)
      return {
        content: [{ type: "text", text: result.text }],
        details: { success: true, tool: tool.definition.name },
      }
    },
  }
}

export function eagerSkillTools(skills: SkillRegistry): readonly AgentTool[] {
  return [skills.searchTool, skills.tool, skills.stageTool]
}

function failureOf(result: AgentRunResult): SubsystemFailure | undefined {
  if (!result.failure) return
  return {
    kind: result.failure.kind,
    ...(result.failure.providerCode ? { providerCode: result.failure.providerCode } : {}),
    ...("httpStatus" in result.failure && result.failure.httpStatus !== undefined
      ? { httpStatus: result.failure.httpStatus }
      : {}),
    ...(result.failure.detail ? { detail: result.failure.detail } : {}),
    retryable: result.failure.retryable,
  }
}

function failureReason(failure: NonNullable<AgentRunResult["failure"]>): string {
  const providerCode = failure.providerCode ? ` · provider code ${failure.providerCode}` : ""
  const httpStatus = "httpStatus" in failure && failure.httpStatus !== undefined ? ` · HTTP ${failure.httpStatus}` : ""
  const detail = failure.detail ? `: ${failure.detail}` : ""
  return `${failure.kind}${providerCode}${httpStatus}${detail}`
}

function terminationOf(result: AgentRunResult): RunTermination {
  if (result.termination === "completed") return "completed"
  if (result.termination === "budget_exhausted") return "budget_exhausted"
  if (result.termination === "cancelled") return "shutdown"
  return "subsystem_failed"
}

function transcriptLine(event: AgentEvent): string {
  return JSON.stringify(PiAudit.redactValue(event))
}

function finalLine(result: AgentRunResult): string {
  return JSON.stringify({
    type: "result",
    result: PiAudit.redactText(result.output),
    run: {
      id: result.id,
      parentID: result.parentID,
      phaseRootID: result.phaseRootID,
      role: result.role,
      provider: result.provider,
      model: result.model,
      providerAffinity: result.providerAffinity,
      identity: result.identity,
      reasoningEffort: result.reasoningEffort,
      effectiveReasoningEffort: result.effectiveReasoningEffort,
      termination: result.termination,
      failure: result.failure,
      usage: result.usage,
      promptManifest: result.promptManifest,
      childRunIDs: result.childRunIDs,
      skillsUsed: result.skillsUsed,
      toolCalls: result.toolCalls,
      fallbackAdmissions: result.fallbackAdmissions,
      fallbackDescendants: result.fallbackDescendants,
    },
  })
}

function boundedUtf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end--
  return bytes.subarray(0, end).toString("utf8")
}

// ── Live Tool Output Is A Projection, Not The Evidence Store ────
// AgentEvents and the authoritative AgentRun retain the complete redacted tool
// result. The live TUI receives at most twelve KiB so rendering cannot scale with
// scanner output size. Before projecting a larger result, the runtime persists
// its full text through the symlink-safe workarea boundary and publishes only a
// content-addressed reference. A failed persistence attempt still bounds the UI;
// the untouched transcript remains the diagnostic fallback.
// ─────────────────────────────────────────────────────────────────
export async function projectLiveEvent(
  event: AgentEvent,
  workarea: string,
  persistedArtifacts: Set<string> = new Set(),
): Promise<AgentEvent> {
  if (event.type !== "activity" || event.activity.kind !== "output") return event
  const bytes = Buffer.byteLength(event.activity.text, "utf8")
  if (bytes <= TUI_TOOL_OUTPUT_BYTES) return event
  const sha256 = createHash("sha256").update(event.activity.text).digest("hex")
  const run = createHash("sha256").update(event.runID).digest("hex").slice(0, 16)
  const call = createHash("sha256").update(event.activity.callID).digest("hex").slice(0, 16)
  const artifact = {
    path: `raw/tool-results/${run}/${call}-${sha256.slice(0, 20)}.txt`,
    sha256,
    bytes,
  }
  let persisted = true
  if (!persistedArtifacts.has(artifact.path))
    await replaceWorkareaFile(workarea, artifact.path, event.activity.text, { mode: 0o600 })
      .then(() => persistedArtifacts.add(artifact.path))
      .catch(() => {
        persisted = false
      })
  const suffix = persisted
    ? "\n…[output projected; expand the card to read the complete artifact]"
    : "\n…[output projected; complete TUI artifact persistence failed]"
  const preview = boundedUtf8Prefix(
    event.activity.text,
    Math.max(1, TUI_TOOL_OUTPUT_BYTES - Buffer.byteLength(suffix, "utf8")),
  )
  return {
    ...event,
    activity: {
      ...event.activity,
      text: `${preview}${suffix}`,
      ...(persisted ? { artifact } : {}),
    },
  }
}

export async function run(input: RunInput, onEvent?: (event: AgentEvent) => void): Promise<RunResult> {
  let bridge: Awaited<ReturnType<typeof connectPiMcp>> | undefined
  let subsystem: PiAgentSubsystem | undefined
  const persistedLiveArtifacts = new Set<string>()
  const rootID = input.rootRunID ?? `run_${randomUUID()}`
  let diagnosticQueue = Promise.resolve()
  const diagnostics = new RuntimeDiagnosticRecorder({
    workarea: input.workarea,
    sessionID: input.sessionID,
    workflow: input.compiledPrompt.manifest.workflow,
    phase: input.compiledPrompt.manifest.phase,
    attempt: input.attempt ?? 1,
    onFirst: (summary) => {
      const event: AgentEvent = {
        type: "activity",
        runID: rootID,
        activity: {
          kind: "status",
          text: JSON.stringify({ runtimeDiagnostic: summary }),
        },
      }
      diagnosticQueue = diagnosticQueue.then(async () => {
        await input.transcript?.append(`${transcriptLine(event)}\n`)
        onEvent?.(event)
      })
    },
  })
  const usageLedger = new ProviderUsageLedger({
    workarea: input.workarea,
    sessionID: input.sessionID,
  })
  const preExecutionToolUsage = new ToolUsageRecorder({
    root: input.workarea,
    phase: input.compiledPrompt.manifest.phase,
    agent: "host-pre-execution",
  })
  const liveState = new RunStateArtifact({
    workarea: input.workarea,
    workflow: input.compiledPrompt.manifest.workflow,
    phase: input.compiledPrompt.manifest.phase,
    attempt: input.attempt ?? 1,
    deadlineAt: input.deadlineAt,
    budgetClock: input.budgetClock,
    closeoutReserveMs: input.closeoutReserveMs ?? 0,
  })
  try {
    await liveState.start()
    const credentials = new PiCredentialStore()
    const registry = createPiModels(input.settings.agent, credentials)
    bridge = await connectPiMcp(input.gateway, {
      cwd: input.workarea,
      askQuestion: input.askQuestion,
      diagnostics,
      budgetClock: input.budgetClock,
    })
    const fallbackLedger = await durableFallbackLedgerForSession(input.sessionID)
    subsystem = new PiAgentSubsystem({
      settings: input.settings,
      registry,
      fallbackLedger,
      usageLedger,
      onShutdown: () => bridge!.close(),
    })
    activeWorkers.add(subsystem)
    const providerRoute = input.providerRoute ?? "main"
    const provider =
      providerRoute === "fallback" ? input.settings.agent.fallback_provider : input.settings.agent.main_provider
    if (!provider) throw new Error("phase recovery requested a fallback provider, but none is configured")
    const model = registry.model(provider)
    const subagentPolicy = Settings.subagentPolicy(input.settings)
    registry.model(subagentPolicy.provider)
    const phaseRecoveredHypotheses = await bridge.recoverHypotheses({
      fromRunID: "*",
      actor: { runID: rootID, displayName: "root", kind: "root" },
      reason: "phase_recovery",
    })
    if (phaseRecoveredHypotheses.length > 0) {
      const event: AgentEvent = {
        type: "activity",
        runID: rootID,
        activity: {
          kind: "status",
          text: `Hypothesis ownership recovered by root: ${phaseRecoveredHypotheses
            .map((item) => item.id)
            .join(", ")}.`,
        },
      }
      await input.transcript?.append(`${transcriptLine(event)}\n`)
      onEvent?.(event)
    }
    const rootSpec: AgentRunSpec = {
      id: rootID,
      sessionID: input.sessionID,
      role: "root",
      depth: 0,
      provider,
      model,
      context: registry.contextCapacity(provider),
      providerAffinity: providerRoute,
      reasoning: PiReasoning.resolve(Settings.reasoningEffort(input.settings), model),
      prompt: input.compiledPrompt,
      compileChildPrompt: input.compileChildPrompt,
      task: input.task,
      workarea: input.workarea,
      gateway: input.gateway,
      tools: [...eagerSkillTools(input.skills), ...(input.dynamicTools ?? []).map(dynamicAgentTool)],
      gatewayTools: (run) =>
        bridge!.toolsFor({
          handoffAuthorized: run.handoffOwner,
          isToolAllowed: () => true,
          actor: {
            runID: run.id,
            displayName: run.identity?.displayName ?? run.role,
            kind: run.role,
            ...(run.parentID ? { parentID: run.parentID } : {}),
          },
        }),
      recoverHypothesisOwnership: (request) =>
        bridge!.recoverHypotheses({
          fromRunID: request.fromRunID,
          actor: request.to,
          reason: request.reason,
        }),
      recoverTestObjects: (request) => bridge!.recoverTestObjects(request),
      releaseBrowserOwner: (request) =>
        bridge!.releaseBrowserOwner({
          runID: request.runID,
          displayName: request.role,
          kind: request.role,
          ...(request.parentID ? { parentID: request.parentID } : {}),
        }),
      skills: input.skills.catalog,
      budget: {
        deadlineAt: input.deadlineAt,
        maxOutputTokens: model.maxTokens,
        ...(input.budgetClock ? { clock: input.budgetClock } : {}),
        ...(input.closeoutReserveMs ? { closeoutReserveMs: input.closeoutReserveMs } : {}),
      },
      abort: input.abort,
      delegation: {
        enabled: input.settings.agent.subagents.enabled,
        provider: subagentPolicy.provider,
        reasoningEfforts: subagentPolicy.reasoning_efforts,
        defaultReasoningEffort: subagentPolicy.default_reasoning_effort,
        maxPerRun: input.settings.agent.subagents.max_per_run,
        maxConcurrent: input.settings.agent.subagents.max_concurrent,
        maxDepth: input.settings.agent.subagents.max_depth,
        maxRuntimeMs: (input.settings.agent.subagents.timeout_minutes ?? 30) * 60_000,
      },
      handoffOwner: input.handoffOwner,
      transcript: {
        enabled: input.transcript !== undefined,
        includeSystemMessage: false,
        redactCredentials: true,
      },
      fallback: {
        providerConfigured: Boolean(input.settings.agent.fallback_provider),
        proactiveEnabled: input.settings.agent.fallback.proactive.enabled,
        proactivePercentage: input.settings.agent.fallback.proactive.percentage,
        automaticSecurityBlockEnabled: input.settings.agent.fallback.automatic_security_block.enabled,
        recoveryBonusMs: Settings.fallbackRecoveryBonusMs(input.settings),
      },
    }
    const root = await subsystem.start(rootSpec)
    const consumeEvents = (async () => {
      for await (const event of root.events) {
        recordAgentDiagnostic(event, diagnostics)
        if (
          event.type === "activity" &&
          event.activity.kind === "output" &&
          event.activity.isError === true &&
          event.activity.preExecution === true &&
          event.activity.tool
        )
          await preExecutionToolUsage.record({
            agent_run_id: event.runID,
            ...(event.activity.actor?.role ? { agent_role: event.activity.actor.role } : {}),
            ...(event.activity.actor?.parentID ? { parent_run_id: event.activity.actor.parentID } : {}),
            tool_call_id: event.activity.callID,
            tool: event.activity.tool,
            outcome: event.activity.blocked ? "blocked" : "error",
            error_class: "invalid_arguments",
            error_code: event.activity.blocked ? "host_policy_block" : "schema_validation",
          })
        await liveState.observe(event)
        await input.transcript?.append(`${transcriptLine(event)}\n`)
        onEvent?.(await projectLiveEvent(event, input.workarea, persistedLiveArtifacts))
      }
    })()
    const result = await root.result
    await consumeEvents
    await liveState.close()
    await input.transcript?.append(`${finalLine(result)}\n`)
    const termination = terminationOf(result)
    return {
      stdout: result.output,
      stderr: "",
      exitCode: termination === "completed" ? 0 : termination === "budget_exhausted" ? 124 : 1,
      timedOut: termination === "budget_exhausted",
      termination,
      ...(result.failure ? { failureReason: failureReason(result.failure) } : {}),
      ...(failureOf(result) ? { failure: failureOf(result) } : {}),
      agentResult: result,
    }
  } catch (error) {
    await liveState.fail({ termination: "spawn_failed", failure: { class: "phase_startup" } })
    diagnostics.record({
      component: "gateway",
      profile: input.gateway.name,
      stage: "startup",
      severity: "error",
      errorClass: error instanceof Error ? error.name || "Error" : "Error",
      message: errorDetail(error),
    })
    return {
      stdout: "",
      stderr: errorDetail(error),
      exitCode: 127,
      timedOut: false,
      termination: "spawn_failed",
      failureReason: errorDetail(error),
    }
  } finally {
    await preExecutionToolUsage.close().catch((error) =>
      diagnostics.record({
        component: "gateway",
        profile: "pre-execution-tool-usage",
        stage: "shutdown",
        severity: "error",
        errorClass: error instanceof Error ? error.name || "Error" : "Error",
        code: "tool_usage_close_failed",
        outcome: "degraded_observability",
        blocking: false,
        message: errorDetail(error),
      }),
    )
    await usageLedger.close().catch((error) =>
      diagnostics.record({
        component: "gateway",
        profile: "provider-usage",
        stage: "shutdown",
        severity: "error",
        errorClass: error instanceof Error ? error.name || "Error" : "Error",
        message: errorDetail(error),
      }),
    )
    await liveState.close().catch((error) =>
      diagnostics.record({
        component: "phase",
        profile: "run-state",
        stage: "shutdown",
        severity: "warning",
        errorClass: error instanceof Error ? error.name || "Error" : "Error",
        code: "run_state_close_failed",
        outcome: "cleanup_failure",
        blocking: false,
        message: errorDetail(error),
      }),
    )
    if (subsystem) {
      await subsystem.shutdown().catch((error) =>
        diagnostics.record({
          component: "phase",
          profile: input.gateway.name,
          stage: "shutdown",
          severity: "error",
          errorClass: error instanceof Error ? error.name || "Error" : "Error",
          code: "worker_shutdown_failed",
          outcome: "cleanup_failure",
          blocking: true,
          message: errorDetail(error),
        }),
      )
      activeWorkers.delete(subsystem)
    } else {
      await bridge?.close().catch((error) =>
        diagnostics.record({
          component: "phase",
          profile: input.gateway.name,
          stage: "shutdown",
          severity: "error",
          errorClass: error instanceof Error ? error.name || "Error" : "Error",
          code: "gateway_shutdown_failed",
          outcome: "cleanup_failure",
          blocking: true,
          message: errorDetail(error),
        }),
      )
    }
    await diagnostics
      .close()
      .catch((error) => emitObservabilityFailure(onEvent, rootID, "runtime_diagnostics_close_failed", error))
    await diagnosticQueue.catch((error) =>
      emitObservabilityFailure(onEvent, rootID, "runtime_diagnostic_projection_failed", error),
    )
  }
}

export async function shutdownAll(): Promise<void> {
  await Promise.allSettled([...activeWorkers].map((worker) => worker.shutdown()))
  activeWorkers.clear()
}

export function activeCount(): number {
  return activeWorkers.size
}

export * as SubsystemPiPhaseRuntime from "./pi-phase-runtime"
