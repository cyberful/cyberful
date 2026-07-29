// ── Pi Phase Worker Owner Runtime ────────────────────────────────
// Owns one phase-scoped in-process Pi subsystem, its single MCP connection,
// skill registry, provider registry, event transcript, and deterministic
// shutdown.
// → cyberful/src/subsystem/phase-runner.ts — validates phase completion.
// ─────────────────────────────────────────────────────────────────

import type { AgentTool } from "@earendil-works/pi-agent-core"
import { createHash } from "node:crypto"
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
import { replaceWorkareaFile } from "@/workarea"

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
  const httpStatus =
    "httpStatus" in failure && failure.httpStatus !== undefined ? ` · HTTP ${failure.httpStatus}` : ""
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
    const provider = input.settings.agent.main_provider
    const rootSpec: AgentRunSpec = {
      sessionID: input.sessionID,
      role: "root",
      depth: 0,
      provider,
      model: registry.model(provider),
      providerAffinity: "main",
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
        enabled: input.transcript !== undefined,
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
        await input.transcript?.append(`${transcriptLine(event)}\n`)
        onEvent?.(await projectLiveEvent(event, input.workarea, persistedLiveArtifacts))
      }
    })()
    const result = await root.result
    await consumeEvents
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
    return {
      stdout: "",
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
