// ── Pi Worker MCP Bridge ─────────────────────────────────────────
// Owns the single private-gateway MCP connection used by one in-process Pi owner,
// projects approved tools, and coordinates host-owned non-execution waits.
// → cyberful/src/subsystem/subsystem.ts — defines the host-owned MCP descriptor.
// → cyberful/src/subsystem/gateway/config.ts — creates private phase gateways.
// → cyberful/src/subsystem/runtime-diagnostics.ts — retains sanitized gateway observations.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import type { AgentTool } from "@earendil-works/pi-agent-core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { createHash } from "node:crypto"
import { Unsafe, type TUnsafe } from "typebox"
import {
  approvalElicitationContent,
  approvalElicitationSchema,
  humanDecisionMetadata,
  isQuestionRejected,
  parseApprovalElicitationMetadata,
  type AskHuman,
} from "./human-question"
import type { SubsystemMcpServer } from "./subsystem"
import type { RuntimeDiagnosticInput, RuntimeDiagnosticRecorder } from "./runtime-diagnostics"
import type { Controller as PhaseBudgetClock } from "./phase-budget-clock"
import type { RecoveredTestObject } from "./agent-subsystem"

const LIST_TIMEOUT_MS = 20_000
const TOOL_TIMEOUT_MS = 600_000
const GATEWAY_INITIALIZATION_TIMEOUT_MS = 6 * 60_000
const HUMAN_WAIT_HEARTBEAT_MS = 30_000
const HUMAN_WAIT_REQUEST_TIMEOUT_MS = 60_000
const HANDOFF_TOOL_NAME = "handoff"
const TARGET_COOLDOWN_TOOL_NAME = "target_cooldown"
const TEST_OBJECT_TOOL_NAME = "test_object"
const BROWSER_OWNER_RELEASE_TOOL_NAME = "_cyberful_browser_owner_release"
const HUMAN_WAIT_TOOL_NAMES = new Set(["question", "source_import"])
const AGENT_BROWSER_SKILLS_GET_TOOL_NAME = "agent_browser_skills_get"
const AGENT_BROWSER_MANAGED_INSTRUCTION_BUNDLE = "agent-browser/core-mcp-managed"
const AGENT_BROWSER_INSTRUCTION_BUNDLE_META = "cyberful.dev/instruction-bundle"
const AGENT_BROWSER_SKILL_RESULT_META = "io.cyberful/agent-browser-skills"
const AGENT_BROWSER_MANAGED_SKILL_NAME = "core-mcp-managed"
const AGENT_BROWSER_MANAGED_SKILL_MAX_BYTES = 32_768
const AGENT_BROWSER_SOURCE_VERSION = "0.34.0-cyberful.3"

type ToolArguments = Record<string, unknown>
type ToolParameters = TUnsafe<ToolArguments>
type PiToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }

export interface PiMcpInstructionBundle {
  readonly id: string
  readonly source: "agent-browser"
  readonly sourceVersion: string
  readonly content: string
  readonly bytes: number
  readonly sha256: string
}

export interface PiMcpInstructionBundleLoader {
  readonly id: string
  readonly load: (signal?: AbortSignal) => Promise<PiMcpInstructionBundle>
}

type PiMcpAgentTool = AgentTool<ToolParameters, PiMcpToolDetails> & {
  readonly instructionBundles?: readonly PiMcpInstructionBundleLoader[]
}

export interface PiMcpToolDetails {
  readonly serverName: string
  readonly toolName: string
  readonly isError: false
  readonly synthesisOutcome?: "diversified" | "exhausted"
  readonly activeBlockingHypotheses?: number
  readonly researchCloseout?: {
    readonly version: 1
    readonly webTarget: boolean
    readonly unusedProfiles: readonly number[]
    readonly coverageCandidateCount: number
    readonly coverageCandidateSamples: readonly string[]
    readonly collectorDegraded: boolean
  }
  readonly convergence?: {
    readonly cluster: string
    readonly negativeHypothesisIDs: readonly string[]
  }
}

export interface PiMcpConnectOptions {
  readonly cwd?: string
  readonly initializationTimeoutMs?: number
  readonly isToolAllowed?: (name: string) => boolean
  readonly askQuestion?: AskHuman
  readonly diagnostics?: RuntimeDiagnosticRecorder
  readonly budgetClock?: PhaseBudgetClock
}

export interface PiMcpRunToolPolicy {
  readonly isToolAllowed: (name: string) => boolean
  readonly handoffAuthorized: boolean
  readonly actor?: {
    readonly runID: string
    readonly displayName: string
    readonly kind: "root" | "subagent" | "fallback"
    readonly parentID?: string
  }
}

export interface PiMcpBridge {
  readonly serverName: string
  toolsFor(policy: PiMcpRunToolPolicy): readonly AgentTool<ToolParameters, PiMcpToolDetails>[]
  recoverHypotheses(input: {
    readonly fromRunID: string | "*"
    readonly actor: NonNullable<PiMcpRunToolPolicy["actor"]>
    readonly reason: "phase_recovery" | "child_finished"
  }): Promise<ReadonlyArray<{ readonly id: string; readonly nextStep?: string }>>
  recoverTestObjects(input: { readonly fromRunID: string }): Promise<readonly RecoveredTestObject[]>
  releaseBrowserOwner(actor: NonNullable<PiMcpRunToolPolicy["actor"]>): Promise<void>
  close(): Promise<void>
}

type McpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number]
type McpCallResult = Awaited<ReturnType<Client["callTool"]>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function printableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    )
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]))
  )
}

function toolErrorText(content: readonly unknown[], structuredContent?: Record<string, unknown>): string {
  const text = content.flatMap((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
  )
  if (text.length > 0) return text.join("\n")
  if (structuredContent) return printableJson(structuredContent)
  return "MCP tool execution failed"
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : "Error"
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined
}

function diagnosticComponent(message: string): "gateway" | "zap" | "browser" | "mcp" {
  if (/\bzap\b|:8080\b|:8090\b/iu.test(message)) return "zap"
  if (/\bbrowser\b|\bplaywright\b|\bchrom(?:e|ium)\b/iu.test(message)) return "browser"
  return "gateway"
}

function toolDiagnosticRoute(name: string): Pick<RuntimeDiagnosticInput, "component" | "route"> {
  if (name === "shell") return { component: "cyberful-os", route: "cyberful-os/shell" }
  if (name === "web_search" || name.startsWith("agent_browser_"))
    return { component: "browser", route: `browser/${name}` }
  if (name.startsWith("zap_")) return { component: "zap", route: `zap/${name}` }
  if (name.startsWith("ghidra_")) return { component: "ghidra", route: `ghidra/${name}` }
  return { component: "gateway", route: `gateway/${name}` }
}

function classifyGatewayStderr(
  message: string,
): Pick<RuntimeDiagnosticInput, "stage" | "severity" | "errorClass" | "code" | "outcome" | "blocking"> {
  const line = message.trim()
  if (/^(?:\[[^\]\r\n]{1,80}\]\s+)?stdio server started$/iu.test(line))
    return {
      stage: "startup",
      severity: "info",
      errorClass: "GatewayLifecycle",
    }
  if (/\bagent-browser\b.*\b(?:launch|daemon|chrome)\b/iu.test(line))
    return {
      stage: "startup",
      severity: "info",
      errorClass: "GatewayLifecycle",
      code: "browser_launch",
      blocking: false,
    }
  if (/\bcleanup recovered\b/iu.test(line))
    return {
      stage: "shutdown",
      severity: "info",
      errorClass: "GatewayLifecycle",
      code: "recovered_cleanup",
      outcome: "recovered_cleanup",
      blocking: false,
    }
  if (/^(?:\[[^\]\r\n]{1,80}\]\s+)?stdio closed$/iu.test(line))
    return {
      stage: "shutdown",
      severity: "info",
      errorClass: "GatewayLifecycle",
    }
  const declaredLevel = line
    .slice(0, 160)
    .match(/\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/iu)?.[1]
    ?.toUpperCase()
  if (declaredLevel === "TRACE" || declaredLevel === "DEBUG" || declaredLevel === "INFO")
    return {
      stage: "startup",
      severity: "info",
      errorClass: "GatewayLog",
    }
  if (declaredLevel === "ERROR" || declaredLevel === "FATAL")
    return {
      stage: "startup",
      severity: "error",
      errorClass: "GatewayStderr",
    }
  return {
    stage: "startup",
    severity: "warning",
    errorClass: "GatewayStderr",
  }
}

function researchCloseoutMetadata(result: McpCallResult): PiMcpToolDetails["researchCloseout"] {
  if ("toolResult" in result || !isRecord(result._meta)) return
  const value = result._meta["cyberful.dev/research-closeout"]
  if (!isRecord(value) || value.version !== 1 || typeof value.webTarget !== "boolean") return
  if (
    !Array.isArray(value.unusedProfiles) ||
    !value.unusedProfiles.every(
      (profile) => typeof profile === "number" && Number.isInteger(profile) && profile >= 1 && profile <= 5,
    ) ||
    typeof value.coverageCandidateCount !== "number" ||
    !Number.isInteger(value.coverageCandidateCount) ||
    value.coverageCandidateCount < 0 ||
    !Array.isArray(value.coverageCandidateSamples) ||
    !value.coverageCandidateSamples.every((route) => typeof route === "string") ||
    typeof value.collectorDegraded !== "boolean"
  )
    return
  return {
    version: 1,
    webTarget: value.webTarget,
    unusedProfiles: [...new Set(value.unusedProfiles)].toSorted(),
    coverageCandidateCount: value.coverageCandidateCount,
    coverageCandidateSamples: value.coverageCandidateSamples.slice(0, 8),
    collectorDegraded: value.collectorDegraded,
  }
}

export function hypothesisDetails(
  name: string,
  result: McpCallResult,
): Pick<
  PiMcpToolDetails,
  "synthesisOutcome" | "activeBlockingHypotheses" | "convergence" | "researchCloseout"
> {
  if (name !== "hypothesis" || "toolResult" in result) return {}
  const researchCloseout = researchCloseoutMetadata(result)
  const text = result.content.find(
    (block): block is Extract<(typeof result.content)[number], { type: "text" }> => block.type === "text",
  )?.text
  if (!text) return { ...(researchCloseout ? { researchCloseout } : {}) }
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)) return {}
    const convergence = isRecord(value.convergence) ? value.convergence : undefined
    const negativeHypothesisIDs = Array.isArray(convergence?.negative_hypothesis_ids)
      ? convergence.negative_hypothesis_ids.filter((id): id is string => typeof id === "string")
      : []
    return {
      ...(value.outcome === "diversified" || value.outcome === "exhausted" ? { synthesisOutcome: value.outcome } : {}),
      ...(typeof value.activeBlockingHypotheses === "number" &&
      (value.outcome === "diversified" || value.outcome === "exhausted")
        ? { activeBlockingHypotheses: Math.max(0, Math.floor(value.activeBlockingHypotheses)) }
        : {}),
      ...(typeof convergence?.cluster === "string" && negativeHypothesisIDs.length >= 2
        ? { convergence: { cluster: convergence.cluster, negativeHypothesisIDs } }
        : {}),
      ...(researchCloseout ? { researchCloseout } : {}),
    }
  } catch {
    return { ...(researchCloseout ? { researchCloseout } : {}) }
  }
}

// ── MCP Metadata Never Crosses The Model Boundary ────────────────
// The gateway may attach annotations, protocol metadata, task identifiers, or
// structured transport details that are useful to its host but are not model
// content. Only text, images, and explicit resource payloads are projected into
// Pi. Unsupported media is represented as text so results remain observable
// without serializing the server descriptor or its private environment.
// ─────────────────────────────────────────────────────────────────
function convertContent(result: McpCallResult, options: { readonly structured?: boolean } = {}): PiToolContent[] {
  if ("toolResult" in result) return [{ type: "text", text: printableJson(result.toolResult) }]

  const content: PiToolContent[] = []
  for (const block of result.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text })
      continue
    }
    if (block.type === "image") {
      content.push({ type: "image", data: block.data, mimeType: block.mimeType })
      continue
    }
    if (block.type === "audio")
      content.push({
        type: "text",
        text: `MCP audio (${block.mimeType}, base64):\n${block.data}`,
      })
    if (block.type === "resource_link")
      content.push({
        type: "text",
        text: `MCP resource link: ${printableJson({
          uri: block.uri,
          name: block.name,
          title: block.title,
          description: block.description,
          mimeType: block.mimeType,
        })}`,
      })
    if (block.type !== "resource") continue
    if ("text" in block.resource) {
      content.push({
        type: "text",
        text: `MCP resource ${block.resource.uri}:\n${block.resource.text}`,
      })
      continue
    }
    if (block.resource.mimeType?.startsWith("image/")) {
      content.push({
        type: "image",
        data: block.resource.blob,
        mimeType: block.resource.mimeType,
      })
      continue
    }
    content.push({
      type: "text",
      text:
        `MCP resource ${block.resource.uri}` +
        `${block.resource.mimeType ? ` (${block.resource.mimeType})` : ""}, base64:\n${block.resource.blob}`,
    })
  }

  if (options.structured !== false && result.structuredContent)
    content.push({
      type: "text",
      text: `MCP structured output:\n${printableJson(result.structuredContent)}`,
    })
  if (content.length === 0) content.push({ type: "text", text: "MCP tool returned no content." })
  return content
}

function isGloballyAuthorized(name: string, options: PiMcpConnectOptions): boolean {
  return options.isToolAllowed?.(name) ?? true
}

function isRunAuthorized(name: string, policy: PiMcpRunToolPolicy): boolean {
  if (name === HANDOFF_TOOL_NAME && !policy.handoffAuthorized) return false
  return policy.isToolAllowed(name)
}

async function listAllTools(client: Client): Promise<McpTool[]> {
  const tools: McpTool[] = []
  const visitedCursors = new Set<string>()
  let cursor: string | undefined
  do {
    const result = await client.listTools(cursor ? { cursor } : undefined, {
      timeout: LIST_TIMEOUT_MS,
      maxTotalTimeout: LIST_TIMEOUT_MS,
    })
    tools.push(...result.tools)
    cursor = result.nextCursor
    if (cursor && visitedCursors.has(cursor)) throw new Error("MCP tool pagination returned a repeated cursor")
    if (cursor) visitedCursors.add(cursor)
  } while (cursor)
  return tools
}

// ── Human Elicitation Stays On The Host Side ─────────────────────
// The gateway may request only the versioned Cyberful approval envelope and its
// exactly corresponding primitive form. Pi and the model never receive the
// selector callback, request metadata, or host decision machinery. Request,
// worker-lifecycle, and transport cancellation converge on one signal; only a
// validated answer or typed human decline receives human-decision attestation.
// ─────────────────────────────────────────────────────────────────
function installElicitationHandler(client: Client, askQuestion: AskHuman | undefined, lifecycleSignal: AbortSignal) {
  client.setRequestHandler(ElicitRequestSchema, async (request, context) => {
    if (request.params.mode === "url") throw new Error("Cyberful accepts only standard MCP form elicitation")
    const questions = parseApprovalElicitationMetadata(request.params._meta)
    if (!questions) throw new Error("Elicitation contains an invalid Cyberful approval envelope")
    if (!sameJson(request.params.requestedSchema, approvalElicitationSchema(questions)))
      throw new Error("Elicitation form does not match its Cyberful approval envelope")
    if (!askQuestion) return { action: "cancel" as const }

    const signal = AbortSignal.any([context.signal, lifecycleSignal])
    if (signal.aborted) return { action: "cancel" as const }
    const progressToken = request.params._meta?.progressToken
    const heartbeat =
      progressToken === undefined
        ? undefined
        : setInterval(() => {
            void context
              .sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: Date.now(),
                  message: "Waiting for human input",
                },
              })
              .catch(() => undefined)
          }, HUMAN_WAIT_HEARTBEAT_MS)
    try {
      const answers = await askQuestion(questions, signal)
      if (signal.aborted) return { action: "cancel" as const }
      const content = approvalElicitationContent(questions, answers)
      if (!content) throw new Error("Human selector returned invalid answers")
      return {
        action: "accept" as const,
        content,
        _meta: humanDecisionMetadata(),
      }
    } catch (error) {
      if (isQuestionRejected(error))
        return {
          action: "decline" as const,
          _meta: humanDecisionMetadata(),
        }
      if (signal.aborted) return { action: "cancel" as const }
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      if (heartbeat) clearInterval(heartbeat)
    }
  })
}

// ── Authorization Is Rechecked At Execution Time ─────────────────
// Connection filtering applies the worker-wide capability ceiling, while each
// toolsFor call creates a distinct catalog for one agent run. A catalog alone
// is not an authorization boundary: stale references and direct host invocation
// can retain a wrapper after policy changes. Execute therefore rechecks both
// layers, and handoff has a hard check because only the phase root may advance.
// ─────────────────────────────────────────────────────────────────
function piTool(
  definition: McpTool,
  client: Client,
  serverName: string,
  connectOptions: PiMcpConnectOptions,
  runPolicy: PiMcpRunToolPolicy,
  isClosed: () => boolean,
  loadInstructionBundle: (id: string, signal?: AbortSignal) => Promise<PiMcpInstructionBundle>,
): PiMcpAgentTool {
  const eager = isRecord(definition._meta) && definition._meta["cyberful.dev/eager"] === true
  const instructionBundle = isRecord(definition._meta) ? definition._meta[AGENT_BROWSER_INSTRUCTION_BUNDLE_META] : undefined
  return {
    name: definition.name,
    label: definition.title ?? definition.annotations?.title ?? definition.name,
    description: definition.description ?? `Call the ${definition.name} Cyberful gateway tool.`,
    parameters: Unsafe<ToolArguments>(definition.inputSchema),
    ...(eager ? { deferLoading: false } : {}),
    ...(typeof instructionBundle === "string"
      ? {
          instructionBundles: [
            {
              id: instructionBundle,
              load: (signal?: AbortSignal) => loadInstructionBundle(instructionBundle, signal),
            },
          ] satisfies PiMcpInstructionBundleLoader[],
        }
      : {}),
    execute: async (toolCallID, params, signal) => {
      if (isClosed()) throw new Error(`MCP bridge ${serverName} is closed`)
      if (!isGloballyAuthorized(definition.name, connectOptions) || !isRunAuthorized(definition.name, runPolicy))
        throw new Error(`MCP tool ${definition.name} is not authorized for this agent run`)
      const arguments_ =
        (definition.name === "hypothesis" || definition.name === TEST_OBJECT_TOOL_NAME) && runPolicy.actor
          ? {
              ...params,
              _cyberful_host: undefined,
              _cyberful_actor: runPolicy.actor,
            }
          : params
      let result: McpCallResult
      try {
        const call = () => {
          if (HUMAN_WAIT_TOOL_NAMES.has(definition.name))
            return client.callTool(
              {
                name: definition.name,
                arguments: arguments_,
                _meta: runPolicy.actor
                  ? {
                      "io.cyberful/tool-actor": {
                        runID: runPolicy.actor.runID,
                        role: runPolicy.actor.kind,
                        ...(runPolicy.actor.parentID ? { parentRunID: runPolicy.actor.parentID } : {}),
                        toolCallID,
                      },
                    }
                  : undefined,
              },
              undefined,
              {
                signal,
                timeout: HUMAN_WAIT_REQUEST_TIMEOUT_MS,
                resetTimeoutOnProgress: true,
                onprogress: () => undefined,
              },
            )
          return client.callTool(
            {
              name: definition.name,
              arguments: arguments_,
              _meta: runPolicy.actor
                ? {
                    "io.cyberful/tool-actor": {
                      runID: runPolicy.actor.runID,
                      role: runPolicy.actor.kind,
                      ...(runPolicy.actor.parentID ? { parentRunID: runPolicy.actor.parentID } : {}),
                      toolCallID,
                    },
                  }
                : undefined,
            },
            undefined,
            {
              signal,
              timeout: TOOL_TIMEOUT_MS,
              maxTotalTimeout: TOOL_TIMEOUT_MS,
              resetTimeoutOnProgress: true,
            },
          )
        }
        result =
          definition.name === TARGET_COOLDOWN_TOOL_NAME && connectOptions.budgetClock
            ? await connectOptions.budgetClock.wait("target_cooldown", call)
            : await call()
      } catch (error) {
        const route = toolDiagnosticRoute(definition.name)
        connectOptions.diagnostics?.record({
          ...route,
          ...(runPolicy.actor?.runID ? { runID: runPolicy.actor.runID } : {}),
          ...(runPolicy.actor?.parentID ? { parentRunID: runPolicy.actor.parentID } : {}),
          ...(runPolicy.actor?.kind ? { role: runPolicy.actor.kind } : {}),
          callID: toolCallID,
          server: serverName,
          profile: definition.name,
          stage: "tool",
          severity: "error",
          errorClass: errorClass(error),
          ...(errorCode(error) ? { code: errorCode(error) } : {}),
          message: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
      if (!("toolResult" in result) && result.isError) {
        const message = toolErrorText(result.content, result.structuredContent)
        const route = toolDiagnosticRoute(definition.name)
        connectOptions.diagnostics?.record({
          ...route,
          ...(runPolicy.actor?.runID ? { runID: runPolicy.actor.runID } : {}),
          ...(runPolicy.actor?.parentID ? { parentRunID: runPolicy.actor.parentID } : {}),
          ...(runPolicy.actor?.kind ? { role: runPolicy.actor.kind } : {}),
          callID: toolCallID,
          server: serverName,
          profile: definition.name,
          stage: "tool",
          severity: "error",
          errorClass: "McpToolError",
          message: `MCP tool '${definition.name}' returned an error.`,
          outcome: "tool_failure",
          blocking: false,
        })
        throw new Error(message)
      }
      const hypothesis = hypothesisDetails(definition.name, result)
      return {
        content: convertContent(result, { structured: definition.name !== AGENT_BROWSER_SKILLS_GET_TOOL_NAME }),
        details: {
          serverName,
          toolName: definition.name,
          isError: false,
          ...hypothesis,
        },
      }
    },
  }
}

class ConnectedPiMcpBridge implements PiMcpBridge {
  private closePromise: Promise<void> | undefined
  private closing = false

  constructor(
    readonly serverName: string,
    private readonly client: Client,
    private readonly definitions: readonly McpTool[],
    private readonly connectOptions: PiMcpConnectOptions,
    private readonly lifecycleAbort: AbortController,
  ) {}

  toolsFor(policy: PiMcpRunToolPolicy): readonly AgentTool<ToolParameters, PiMcpToolDetails>[] {
    const runPolicy = {
      isToolAllowed: policy.isToolAllowed,
      handoffAuthorized: policy.handoffAuthorized,
      ...(policy.actor ? { actor: policy.actor } : {}),
    } satisfies PiMcpRunToolPolicy
    return this.definitions
      .filter(
        (definition) =>
          isGloballyAuthorized(definition.name, this.connectOptions) && isRunAuthorized(definition.name, runPolicy),
      )
      .map((definition) =>
        piTool(
          definition,
          this.client,
          this.serverName,
          this.connectOptions,
          runPolicy,
          () => this.closing,
          (id, signal) => this.loadInstructionBundle(id, runPolicy, signal),
        ),
      )
  }

  // ── Browser Instructions Arrive Before Browser Capability ──────
  // The bundle is fetched through the same private gateway and AgentRun actor
  // as the tool catalog that requested it. The gateway has already collapsed
  // agent-browser's repeated CLI envelope, but the bridge still validates the
  // expected name, byte count, and digest before model-visible use. A failed
  // load rejects tool discovery, so an operational tool never appears alone.
  // ─────────────────────────────────────────────────────────────────
  private async loadInstructionBundle(
    id: string,
    runPolicy: PiMcpRunToolPolicy,
    signal?: AbortSignal,
  ): Promise<PiMcpInstructionBundle> {
    if (id !== AGENT_BROWSER_MANAGED_INSTRUCTION_BUNDLE)
      throw new Error(`Unknown deferred instruction bundle '${id}'`)
    if (this.closing) throw new Error(`MCP bridge ${this.serverName} is closed`)
    const definition = this.definitions.find((candidate) => candidate.name === AGENT_BROWSER_SKILLS_GET_TOOL_NAME)
    if (!definition) throw new Error("agent-browser managed instructions are unavailable")
    if (!runPolicy.actor) throw new Error("agent-browser managed instructions require an AgentRun identity")
    const result = await this.client.callTool(
      {
        name: definition.name,
        arguments: {
          names: [AGENT_BROWSER_MANAGED_SKILL_NAME],
          full: false,
          profile: "search",
        },
        _meta: {
          "io.cyberful/tool-actor": {
            runID: runPolicy.actor.runID,
            role: runPolicy.actor.kind,
            ...(runPolicy.actor.parentID ? { parentRunID: runPolicy.actor.parentID } : {}),
          },
        },
      },
      undefined,
      {
        signal,
        timeout: LIST_TIMEOUT_MS,
        maxTotalTimeout: LIST_TIMEOUT_MS,
      },
    )
    if (!("toolResult" in result) && result.isError)
      throw new Error(toolErrorText(result.content, result.structuredContent))
    if ("toolResult" in result) throw new Error("agent-browser managed instructions returned an unsupported result")
    const metadata = isRecord(result._meta) ? result._meta[AGENT_BROWSER_SKILL_RESULT_META] : undefined
    const entry = Array.isArray(metadata) && metadata.length === 1 && isRecord(metadata[0]) ? metadata[0] : undefined
    const content = result.content.length === 1 && result.content[0]?.type === "text" ? result.content[0].text : undefined
    if (
      entry?.name !== AGENT_BROWSER_MANAGED_SKILL_NAME ||
      typeof entry.bytes !== "number" ||
      typeof entry.sha256 !== "string" ||
      typeof content !== "string"
    )
      throw new Error("agent-browser managed instructions returned a malformed projection")
    const bytes = Buffer.byteLength(content)
    if (bytes <= 0 || bytes > AGENT_BROWSER_MANAGED_SKILL_MAX_BYTES)
      throw new Error(`agent-browser managed instructions exceed ${AGENT_BROWSER_MANAGED_SKILL_MAX_BYTES} bytes`)
    const sha256 = createHash("sha256").update(content).digest("hex")
    if (entry.bytes !== bytes || entry.sha256 !== sha256)
      throw new Error("agent-browser managed instructions failed integrity validation")
    return {
      id,
      source: "agent-browser",
      sourceVersion: AGENT_BROWSER_SOURCE_VERSION,
      content,
      bytes,
      sha256,
    }
  }

  async recoverHypotheses(input: {
    readonly fromRunID: string | "*"
    readonly actor: NonNullable<PiMcpRunToolPolicy["actor"]>
    readonly reason: "phase_recovery" | "child_finished"
  }) {
    const definition = this.definitions.find((candidate) => candidate.name === "hypothesis")
    if (!definition) return []
    if (this.closing) throw new Error(`MCP bridge ${this.serverName} is closed`)
    const result = await this.client.callTool(
      {
        name: definition.name,
        arguments: {
          action: "recover_ownership",
          fromRunID: input.fromRunID,
          reason: input.reason,
          _cyberful_host: true,
          _cyberful_actor: input.actor,
        },
      },
      undefined,
      {
        timeout: TOOL_TIMEOUT_MS,
        maxTotalTimeout: TOOL_TIMEOUT_MS,
      },
    )
    if (!("toolResult" in result) && result.isError)
      throw new Error(toolErrorText(result.content, result.structuredContent))
    const text = convertContent(result).find(
      (item): item is Extract<PiToolContent, { type: "text" }> => item.type === "text",
    )?.text
    if (!text) return []
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) =>
      isRecord(item) && typeof item.id === "string"
        ? [
            {
              id: item.id,
              ...(typeof item.nextStep === "string" ? { nextStep: item.nextStep } : {}),
            },
          ]
        : [],
    )
  }

  async recoverTestObjects(input: { readonly fromRunID: string }): Promise<readonly RecoveredTestObject[]> {
    const definition = this.definitions.find((candidate) => candidate.name === TEST_OBJECT_TOOL_NAME)
    if (!definition) return []
    if (this.closing) throw new Error(`MCP bridge ${this.serverName} is closed`)
    const result = await this.client.callTool(
      {
        name: definition.name,
        arguments: {
          action: "recover",
          fromRunID: input.fromRunID,
          _cyberful_host: true,
        },
      },
      undefined,
      {
        timeout: TOOL_TIMEOUT_MS,
        maxTotalTimeout: TOOL_TIMEOUT_MS,
      },
    )
    if (!("toolResult" in result) && result.isError)
      throw new Error(toolErrorText(result.content, result.structuredContent))
    const text = convertContent(result).find(
      (item): item is Extract<PiToolContent, { type: "text" }> => item.type === "text",
    )?.text
    if (!text) return []
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed) || !Array.isArray(parsed.objects)) return []
    const states = new Set([
      "planned",
      "not_created",
      "created",
      "oracle_checked",
      "cleanup_attempted",
      "cleaned",
      "residual",
    ])
    return parsed.objects.flatMap((item) => {
      if (
        !isRecord(item) ||
        typeof item.id !== "string" ||
        typeof item.kind !== "string" ||
        typeof item.label !== "string" ||
        typeof item.state !== "string" ||
        !states.has(item.state) ||
        typeof item.phase !== "string"
      )
        return []
      return [
        {
          id: item.id,
          kind: item.kind,
          label: item.label,
          state: item.state as RecoveredTestObject["state"],
          phase: item.phase,
          ...(typeof item.evidencePath === "string" ? { evidencePath: item.evidencePath } : {}),
          ...(typeof item.evidenceExists === "boolean" ? { evidenceExists: item.evidenceExists } : {}),
          ...(typeof item.note === "string" ? { note: item.note } : {}),
          ...(typeof item.residualReason === "string" ? { residualReason: item.residualReason } : {}),
        },
      ]
    })
  }

  async releaseBrowserOwner(actor: NonNullable<PiMcpRunToolPolicy["actor"]>): Promise<void> {
    if (this.closing) return
    const result = await this.client.callTool(
      {
        name: BROWSER_OWNER_RELEASE_TOOL_NAME,
        arguments: { run_id: actor.runID },
        _meta: {
          "io.cyberful/browser-owner-release": 1,
          "io.cyberful/tool-actor": {
            runID: actor.runID,
            role: actor.kind,
            ...(actor.parentID ? { parentRunID: actor.parentID } : {}),
            toolCallID: "browser-owner-release",
          },
        },
      },
      undefined,
      { timeout: TOOL_TIMEOUT_MS, maxTotalTimeout: TOOL_TIMEOUT_MS },
    )
    if (!("toolResult" in result) && result.isError)
      throw new Error(toolErrorText(result.content, result.structuredContent))
  }

  // Normal completion, cancellation, and worker shutdown may converge here.
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.lifecycleAbort.abort(new Error(`MCP bridge ${this.serverName} is closing`))
    this.closePromise = this.client.close().catch((error) => {
      this.connectOptions.diagnostics?.record({
        component: "mcp",
        profile: this.serverName,
        stage: "shutdown",
        severity: "error",
        errorClass: errorClass(error),
        ...(errorCode(error) ? { code: errorCode(error) } : {}),
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    })
    return this.closePromise
  }
}

// ── The Bridge Instance Is The Worker Connection Owner ───────────
// A worker calls this factory once and shares its discovered definitions across
// all root, child, and fallback contexts. Each context independently projects
// those definitions through toolsFor, so handoff ownership never becomes a
// worker-wide setting. Gateway initialization has an explicit finite allowance
// for its sequential local upstreams instead of inheriting the SDK's generic
// one-minute request timeout. Partial failure closes the process, while successful
// ownership remains until the idempotent close method settles.
// ─────────────────────────────────────────────────────────────────
export async function connectPiMcp(server: SubsystemMcpServer, options: PiMcpConnectOptions): Promise<PiMcpBridge> {
  const initializationTimeoutMs = options.initializationTimeoutMs ?? GATEWAY_INITIALIZATION_TIMEOUT_MS
  if (!Number.isSafeInteger(initializationTimeoutMs) || initializationTimeoutMs <= 0)
    throw new RangeError("MCP gateway initialization timeout must be a positive safe integer")
  const transport = new StdioClientTransport({
    command: server.command,
    args: [...server.args],
    env: {
      ...getDefaultEnvironment(),
      ...server.env,
      ...server.privateEnv,
    },
    cwd: options.cwd,
    stderr: "pipe",
  })
  let stderrBuffer = ""
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString()
    const lines = stderrBuffer.split(/\r?\n/u)
    stderrBuffer = lines.pop() ?? ""
    for (const line of lines)
      if (line.trim()) {
        const classification = classifyGatewayStderr(line)
        options.diagnostics?.record({
          component: diagnosticComponent(line),
          profile: server.name,
          ...classification,
          message: line,
        })
      }
  })
  const lifecycleAbort = new AbortController()
  const client = new Client(
    { name: "cyberful-pi-worker", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  )
  installElicitationHandler(client, options.askQuestion, lifecycleAbort.signal)

  try {
    await client.connect(transport, {
      timeout: initializationTimeoutMs,
      maxTotalTimeout: initializationTimeoutMs,
    })
    const definitions = await listAllTools(client)
    const names = new Set<string>()
    for (const definition of definitions) {
      if (names.has(definition.name)) throw new Error(`MCP gateway exposed duplicate tool ${definition.name}`)
      names.add(definition.name)
    }
    return new ConnectedPiMcpBridge(
      server.name,
      client,
      definitions.filter((definition) => isGloballyAuthorized(definition.name, options)),
      options,
      lifecycleAbort,
    )
  } catch (error) {
    if (stderrBuffer.trim()) {
      const classification = classifyGatewayStderr(stderrBuffer)
      options.diagnostics?.record({
        component: diagnosticComponent(stderrBuffer),
        profile: server.name,
        ...classification,
        message: stderrBuffer,
      })
    }
    options.diagnostics?.record({
      component: "mcp",
      profile: server.name,
      stage: "connect",
      severity: "error",
      errorClass: errorClass(error),
      ...(errorCode(error) ? { code: errorCode(error) } : {}),
      message: error instanceof Error ? error.message : String(error),
    })
    lifecycleAbort.abort(error)
    try {
      await client.close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Failed to initialize MCP gateway ${server.name}`)
    }
    throw new Error(`Failed to initialize MCP gateway ${server.name}`, { cause: error })
  }
}
