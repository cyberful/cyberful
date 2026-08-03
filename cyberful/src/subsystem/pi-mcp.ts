// ── Pi Worker MCP Bridge ─────────────────────────────────────────
// Owns the single private-gateway MCP connection used by one in-process Pi owner,
// projects approved tools, and routes human elicitation to the host selector.
// → cyberful/src/subsystem/subsystem.ts — defines the host-owned MCP descriptor.
// → cyberful/src/subsystem/gateway/config.ts — creates private phase gateways.
// → cyberful/src/subsystem/runtime-diagnostics.ts — retains sanitized gateway observations.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import type { AgentTool } from "@earendil-works/pi-agent-core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js"
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

const LIST_TIMEOUT_MS = 20_000
const TOOL_TIMEOUT_MS = 600_000
const HANDOFF_TOOL_NAME = "handoff"

type ToolArguments = Record<string, unknown>
type ToolParameters = TUnsafe<ToolArguments>
type PiToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }

export interface PiMcpToolDetails {
  readonly serverName: string
  readonly toolName: string
  readonly isError: false
  readonly synthesisOutcome?: "diversified" | "exhausted"
  readonly activeBlockingHypotheses?: number
}

export interface PiMcpConnectOptions {
  readonly cwd?: string
  readonly isToolAllowed?: (name: string) => boolean
  readonly askQuestion?: AskHuman
  readonly diagnostics?: RuntimeDiagnosticRecorder
}

export interface PiMcpRunToolPolicy {
  readonly isToolAllowed: (name: string) => boolean
  readonly handoffAuthorized: boolean
  readonly actor?: {
    readonly runID: string
    readonly displayName: string
    readonly kind: "root" | "subagent" | "fallback"
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

function classifyGatewayStderr(
  message: string,
): Pick<
  RuntimeDiagnosticInput,
  "stage" | "severity" | "errorClass" | "code" | "outcome" | "blocking"
> {
  const line = message.trim()
  if (/^(?:\[[^\]\r\n]{1,80}\]\s+)?stdio server started$/iu.test(line))
    return {
      stage: "startup",
      severity: "info",
      errorClass: "GatewayLifecycle",
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
  const declaredLevel = line.slice(0, 160).match(/\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/iu)?.[1]?.toUpperCase()
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

function hypothesisSynthesisDetails(
  name: string,
  result: McpCallResult,
): Pick<PiMcpToolDetails, "synthesisOutcome" | "activeBlockingHypotheses"> {
  if (name !== "hypothesis" || "toolResult" in result) return {}
  const text = result.content.find(
    (block): block is Extract<(typeof result.content)[number], { type: "text" }> => block.type === "text",
  )?.text
  if (!text) return {}
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value) || (value.outcome !== "diversified" && value.outcome !== "exhausted")) return {}
    return {
      synthesisOutcome: value.outcome,
      ...(typeof value.activeBlockingHypotheses === "number"
        ? { activeBlockingHypotheses: Math.max(0, Math.floor(value.activeBlockingHypotheses)) }
        : {}),
    }
  } catch {
    return {}
  }
}

// ── MCP Metadata Never Crosses The Model Boundary ────────────────
// The gateway may attach annotations, protocol metadata, task identifiers, or
// structured transport details that are useful to its host but are not model
// content. Only text, images, and explicit resource payloads are projected into
// Pi. Unsupported media is represented as text so results remain observable
// without serializing the server descriptor or its private environment.
// ─────────────────────────────────────────────────────────────────
function convertContent(result: McpCallResult): PiToolContent[] {
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

  if (result.structuredContent)
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
): AgentTool<ToolParameters, PiMcpToolDetails> {
  return {
    name: definition.name,
    label: definition.title ?? definition.annotations?.title ?? definition.name,
    description: definition.description ?? `Call the ${definition.name} Cyberful gateway tool.`,
    parameters: Unsafe<ToolArguments>(definition.inputSchema),
    execute: async (_toolCallID, params, signal) => {
      if (isClosed()) throw new Error(`MCP bridge ${serverName} is closed`)
      if (!isGloballyAuthorized(definition.name, connectOptions) || !isRunAuthorized(definition.name, runPolicy))
        throw new Error(`MCP tool ${definition.name} is not authorized for this agent run`)
      const arguments_ =
        definition.name === "hypothesis" && runPolicy.actor
          ? {
              ...params,
              _cyberful_host: undefined,
              _cyberful_actor: runPolicy.actor,
            }
          : params
      let result: McpCallResult
      try {
        result = await client.callTool({ name: definition.name, arguments: arguments_ }, undefined, {
          signal,
          timeout: TOOL_TIMEOUT_MS,
          maxTotalTimeout: TOOL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
        })
      } catch (error) {
        connectOptions.diagnostics?.record({
          component: diagnosticComponent(
            `${definition.name} ${error instanceof Error ? error.message : String(error)}`,
          ),
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
        connectOptions.diagnostics?.record({
          component: diagnosticComponent(`${definition.name} ${message}`),
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
      const synthesis = hypothesisSynthesisDetails(definition.name, result)
      return {
        content: convertContent(result),
        details: {
          serverName,
          toolName: definition.name,
          isError: false,
          ...synthesis,
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
        piTool(definition, this.client, this.serverName, this.connectOptions, runPolicy, () => this.closing),
      )
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
// worker-wide setting. Partial initialization failure closes the process, while
// successful ownership remains until the idempotent close method settles.
// ─────────────────────────────────────────────────────────────────
export async function connectPiMcp(server: SubsystemMcpServer, options: PiMcpConnectOptions): Promise<PiMcpBridge> {
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
    await client.connect(transport)
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
