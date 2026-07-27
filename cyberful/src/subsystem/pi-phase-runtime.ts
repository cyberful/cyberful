// ── Pi Phase Worker Owner Runtime ────────────────────────────────
// Owns one phase-scoped in-process Pi subsystem, its single MCP connection,
// skill registry, provider registry, event transcript, and deterministic
// shutdown.
// → cyberful/src/subsystem/phase-runner.ts — validates phase completion.
// ─────────────────────────────────────────────────────────────────

import type { AgentTool } from "@earendil-works/pi-agent-core"
import { Unsafe } from "typebox"
import type { Settings } from "@/config/settings"
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentTaskCapsule,
  ChildPromptInput,
} from "./agent-subsystem"
import type { DynamicTool, SubsystemFailure, SubsystemMcpServer } from "./subsystem"
import type { CompiledAgentPrompt } from "./prompt-compiler"
import type { SkillRegistry } from "./pi-skills"
import type { AskHuman } from "./human-question"
import type { Controller as ApprovalController } from "./approval-state"
import { PiCredentialStore } from "./pi-credentials"
import { PiAgentSubsystem } from "./pi-agent"
import { durableFallbackLedgerForSession } from "./pi-fallback-ledger"
import { connectPiMcp } from "./pi-mcp"
import { createPiModels } from "./pi-models"
import { PiAudit } from "./pi-audit"

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
  readonly askQuestion?: AskHuman
  readonly approvalState?: ApprovalController
  readonly handoffOwner: boolean
  readonly transcriptEnabled: boolean
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

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function dynamicAgentTool(tool: DynamicTool): AgentTool {
  return {
    name: tool.definition.name,
    label: tool.definition.name,
    description: tool.definition.description,
    parameters: Unsafe(tool.definition.inputSchema),
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

function failureOf(result: AgentRunResult): SubsystemFailure | undefined {
  if (!result.failure) return
  return {
    kind: result.failure.kind,
    ...(result.failure.providerCode ? { providerCode: result.failure.providerCode } : {}),
    retryable: result.failure.retryable,
  }
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

export async function run(input: RunInput, onEvent?: (event: AgentEvent) => void): Promise<RunResult> {
  let bridge: Awaited<ReturnType<typeof connectPiMcp>> | undefined
  let subsystem: PiAgentSubsystem | undefined
  const transcript: string[] = []
  try {
    const credentials = new PiCredentialStore()
    const registry = createPiModels(input.settings.agent, credentials)
    bridge = await connectPiMcp(input.gateway, {
      cwd: input.workarea,
      askQuestion: input.askQuestion,
    })
    const fallbackLedger = await durableFallbackLedgerForSession(input.sessionID)
    subsystem = new PiAgentSubsystem({
      settings: input.settings,
      registry,
      fallbackLedger,
      onShutdown: () => bridge!.close(),
    })
    activeWorkers.add(subsystem)
    const provider = input.settings.agent.primary_provider
    const rootSpec: AgentRunSpec = {
      sessionID: input.sessionID,
      role: "root",
      depth: 0,
      provider,
      model: registry.model(provider),
      providerAffinity: "primary",
      prompt: input.compiledPrompt,
      compileChildPrompt: input.compileChildPrompt,
      task: input.task,
      workarea: input.workarea,
      gateway: input.gateway,
      tools: [input.skills.tool, ...(input.dynamicTools ?? []).map(dynamicAgentTool)],
      gatewayTools: (run) =>
        bridge!.toolsFor({
          handoffAuthorized: run.handoffOwner,
          isToolAllowed: () => true,
        }),
      skills: input.skills.catalog,
      budget: {
        deadlineAt: input.deadlineAt,
        maxOutputTokens: registry.model(provider).maxTokens,
        ...(input.approvalState ? { pause: input.approvalState } : {}),
      },
      abort: input.abort,
      delegation: {
        enabled: input.settings.agent.subagents.enabled,
        maxPerRun: input.settings.agent.subagents.max_per_run,
        maxConcurrent: input.settings.agent.subagents.max_concurrent,
        maxDepth: input.settings.agent.subagents.max_depth,
      },
      handoffOwner: input.handoffOwner,
      transcript: {
        enabled: input.transcriptEnabled,
        includeSystemMessage: false,
        redactCredentials: true,
      },
      fallback: {
        providerConfigured: Boolean(input.settings.agent.fallback_provider),
        proactiveEnabled: input.settings.agent.fallback.proactive.enabled,
        proactivePercentage: input.settings.agent.fallback.proactive.percentage,
        automaticSecurityBlockEnabled: input.settings.agent.fallback.automatic_security_block.enabled,
      },
    }
    const root = await subsystem.start(rootSpec)
    const consumeEvents = (async () => {
      for await (const event of root.events) {
        if (input.transcriptEnabled) transcript.push(transcriptLine(event))
        onEvent?.(event)
      }
    })()
    const result = await root.result
    await consumeEvents
    if (input.transcriptEnabled) transcript.push(finalLine(result))
    const termination = terminationOf(result)
    return {
      stdout: input.transcriptEnabled ? `${transcript.join("\n")}\n` : result.output,
      stderr: "",
      exitCode: termination === "completed" ? 0 : termination === "budget_exhausted" ? 124 : 1,
      timedOut: termination === "budget_exhausted",
      termination,
      ...(result.failure ? { failureReason: result.failure.kind } : {}),
      ...(failureOf(result) ? { failure: failureOf(result) } : {}),
      agentResult: result,
    }
  } catch (error) {
    return {
      stdout: transcript.length > 0 ? `${transcript.join("\n")}\n` : "",
      stderr: errorDetail(error),
      exitCode: 127,
      timedOut: false,
      termination: "spawn_failed",
      failureReason: errorDetail(error),
    }
  } finally {
    if (subsystem) {
      await subsystem.shutdown().catch(() => undefined)
      activeWorkers.delete(subsystem)
    } else {
      await bridge?.close().catch(() => undefined)
    }
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
