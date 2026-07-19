// ── Codex Phase Provider Adapter ─────────────────────────────────
// Translates one capability-level phase run into the sole isolated Codex CLI
// invocation, including sandbox, gateway, environment, and activity event policy.
// → cyberful/src/subsystem/cli.ts — executes the resulting run specification.
// ─────────────────────────────────────────────────────────────────

import { webSearchMode, type ExpertBackend } from "@/dependency/config"
import { SubsystemCodex } from "./codex"
import type { SubsystemUsage } from "./usage"

export type SubsystemPermission = { kind: "readonly" | "workareaEdit" | "autonomous" }

export interface SubsystemMcpServer {
  name: string
  command: string
  args: readonly string[]
  // Registration-safe values only; engagement credentials belong in privateEnv.
  env: Readonly<Record<string, string>>
  privateEnv?: Readonly<Record<string, string>>
}

export interface SubsystemRunSpec {
  cwd: string
  permission: SubsystemPermission
  model?: string
  // False disables both Codex web search and direct sandbox egress.
  networkAccess?: boolean
  // Explicit gateway registration; personal and project MCP servers stay excluded.
  mcpServer?: SubsystemMcpServer
  // Product and phase policy layered after Codex's model-specific base instructions.
  developerInstructions?: string
  // Opens Codex's native multi-agent tools only after the phase persona and Ultra effort authorize them.
  nativeSubagents?: boolean
  // Additional native skill roots exposed through app-server progressive disclosure.
  skillRoots?: readonly string[]
  // Relative Markdown deliverables owned by this run. Cleanup may normalize only these named files.
  markdownArtifacts?: readonly string[]
  stream?: boolean
  env?: Record<string, string>
}

export type PhaseActivityActor = {
  id: string
  label?: string
  parentID?: string
}

export type PhaseActivityActorState = "started" | "active" | "interacted" | "completed" | "interrupted" | "failed"

type PhaseActivityContext = { actor?: PhaseActivityActor }

export type PhaseActivity = PhaseActivityContext &
  (
    | { kind: "text"; text: string }
    | { kind: "tool"; tool: string; input: unknown; callID: string }
    | { kind: "output"; text: string; callID: string }
    | { kind: "progress"; usage: SubsystemUsage.Snapshot }
    | { kind: "agent"; actor: PhaseActivityActor; state: PhaseActivityActorState; transitionID: string }
  )

export interface Provider {
  readonly name: ExpertBackend
  buildArgs(spec: SubsystemRunSpec): { args: string[]; extraEnv: Record<string, string> }
  // Phase runs use app-server so the host can call turn/steer while a turn is running.
  buildAppServerArgs(spec: SubsystemRunSpec): { args: string[]; extraEnv: Record<string, string> }
  extractResultText(stdout: string): string
  streamActivities(event: unknown): PhaseActivity[]
}

// ── Actor References Resolve Inside One Subsystem Run ────────────
// Providers may learn an actor's readable identity from one lifecycle event
// while later work events carry only its opaque id. A projection instance owns
// that registry for exactly one run, enriches subsequent references, and drops
// lifecycle updates for actors that were never announced. Concurrent subsystem
// runs therefore cannot leak identities or state into one another.
//
// ─────────────────────────────────────────────────────────────────
export function createActivityActorProjection() {
  const actors = new Map<string, PhaseActivityActor>()
  return (activity: PhaseActivity): PhaseActivity | undefined => {
    const actor = activity.actor
    if (!actor) return activity
    if (actor.label) {
      const resolved = { ...actors.get(actor.id), ...actor }
      actors.set(actor.id, resolved)
      return { ...activity, actor: resolved }
    }
    const resolved = actors.get(actor.id)
    if (resolved) return { ...activity, actor: resolved }
    return activity.kind === "agent" ? undefined : activity
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(",")}]`
}

function codexMcpArgs(server: SubsystemMcpServer): string[] {
  const prefix = `mcp_servers.${server.name}`
  const env = Object.entries(server.env)
    .map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`)
    .join(",")
  return [
    "-c",
    `${prefix}.command=${tomlString(server.command)}`,
    "-c",
    `${prefix}.args=${tomlStringArray(server.args)}`,
    "-c",
    `${prefix}.env={${env}}`,
    "-c",
    `${prefix}.required=true`,
    "-c",
    `${prefix}.startup_timeout_sec=60`,
    "-c",
    `${prefix}.tool_timeout_sec=600`,
    "-c",
    `${prefix}.default_tools_approval_mode=${tomlString("approve")}`,
  ]
}

function codexMcpTable(server: SubsystemMcpServer): string {
  const env = Object.entries(server.env)
    .map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`)
    .join(",")
  return (
    `{${tomlString(server.name)}={` +
    `command=${tomlString(server.command)},` +
    `args=${tomlStringArray(server.args)},` +
    `env={${env}},required=true,startup_timeout_sec=60,tool_timeout_sec=600,` +
    `default_tools_approval_mode=${tomlString("approve")}}}`
  )
}

function codexConfigArgs(spec: SubsystemRunSpec): string[] {
  const networkAccess = spec.networkAccess !== false
  const args = [
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "features.apps=false",
    "-c",
    `features.multi_agent=${spec.nativeSubagents === true ? "true" : "false"}`,
    "-c",
    "features.multi_agent_v2=false",
    "-c",
    `web_search=${tomlString(networkAccess ? webSearchMode() : "disabled")}`,
    "-c",
    'otel.exporter="none"',
    "-c",
    'otel.trace_exporter="none"',
    "-c",
    'otel.metrics_exporter="none"',
    "-c",
    "otel.log_user_prompt=false",
    "-c",
    `sandbox_workspace_write.network_access=${networkAccess ? "true" : "false"}`,
    "-c",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "-c",
    "sandbox_workspace_write.exclude_slash_tmp=true",
  ]
  if (spec.developerInstructions) args.push("-c", `developer_instructions=${tomlString(spec.developerInstructions)}`)
  if (spec.mcpServer) args.push("-c", `mcp_servers=${codexMcpTable(spec.mcpServer)}`)
  return args
}

// ── Buffered Results Accept JSON Events Or Plain Final Text ──────────
// Codex's buffered boundary can return an NDJSON transcript or a plain final
// response, depending on the selected execution mode. Each line is therefore
// parsed as JSON first, with SyntaxError alone selecting the supported text
// fallback. Any other parser failure is unexpected and remains visible rather
// than being converted into an apparently valid empty result.
// ──────────────────────────────────────────────────────────────
function parseJsonLine(line: string): unknown | undefined {
  try {
    return JSON.parse(line)
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

export const codex: Provider = {
  name: "codex",
  buildArgs(spec) {
    const sandbox = spec.permission.kind === "readonly" ? "read-only" : "workspace-write"
    const args = [
      "--sandbox",
      sandbox,
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--skip-git-repo-check",
      ...codexConfigArgs({ ...spec, mcpServer: undefined }),
    ]
    if (spec.model) args.push("--model", spec.model)
    args.push("-c", `model_reasoning_effort=${tomlString(SubsystemCodex.effort())}`)
    if (spec.mcpServer) args.push(...codexMcpArgs(spec.mcpServer))
    args.push("-")
    return { args, extraEnv: { ...(spec.env ?? {}) } }
  },
  buildAppServerArgs(spec) {
    return {
      args: ["app-server", "--stdio", "--strict-config", ...codexConfigArgs(spec)],
      extraEnv: { ...(spec.env ?? {}) },
    }
  },
  extractResultText(stdout) {
    const trimmed = stdout.trim()
    if (!trimmed) return ""
    let lastText: string | undefined
    let sawJson = false
    for (const line of trimmed.split("\n")) {
      const event = parseJsonLine(line)
      if (event === undefined) continue
      sawJson = true
      if (!isRecord(event)) continue
      if (event.type === "item.completed" && isRecord(event.item)) {
        if (event.item.type === "agent_message" && typeof event.item.text === "string") lastText = event.item.text
        continue
      }
      if (event.method === "item/completed" && isRecord(event.params) && isRecord(event.params.item)) {
        if (event.params.item.type === "agentMessage" && typeof event.params.item.text === "string")
          lastText = event.params.item.text
      }
    }
    return lastText ?? (sawJson ? "" : stdout)
  },
  streamActivities(event) {
    if (!isRecord(event)) return []
    const actor = appServerActor(event)
    const actorContext = actor ? { actor } : {}
    const settings = SubsystemCodex.threadSettings(event)
    if (settings) {
      const callID = `codex-settings-${settings.threadID}`
      return [
        {
          kind: "tool",
          tool: "codex.settings",
          input: { effort: settings.effort, multiAgentMode: settings.multiAgentMode },
          callID,
        },
        {
          kind: "output",
          text: `Resolved effort=${settings.effort ?? "null"}, multiAgentMode=${settings.multiAgentMode || "missing"}`,
          callID,
        },
      ]
    }
    if (event.method === "thread/tokenUsage/updated" && isRecord(event.params)) {
      const usage = isRecord(event.params.tokenUsage) ? event.params.tokenUsage : undefined
      const total = usage && isRecord(usage.total) ? usage.total : undefined
      if (total && typeof total.outputTokens === "number")
        return [
          {
            kind: "progress",
            usage: {
              generatedTokens: total.outputTokens,
              ...(typeof total.inputTokens === "number" ? { inputTokens: total.inputTokens } : {}),
              ...(typeof total.reasoningOutputTokens === "number"
                ? { reasoningTokens: total.reasoningOutputTokens }
                : {}),
              ...(typeof total.cachedInputTokens === "number" ? { cacheReadTokens: total.cachedInputTokens } : {}),
              ...(typeof event.params.threadId === "string" ? { scopeID: event.params.threadId } : {}),
            },
          },
        ]
    }
    if (event.method === "mcpServer/startupStatus/updated" && isRecord(event.params)) {
      const name = typeof event.params.name === "string" ? event.params.name : "unknown"
      const status = typeof event.params.status === "string" ? event.params.status : "unknown"
      const callID = `mcp-startup-${actor?.id ?? "thread"}-${name}`
      if (status === "starting")
        return [{ kind: "tool", tool: `mcp.${name}.startup`, input: { status }, callID, ...actorContext }]
      return [
        {
          kind: "output",
          text: JSON.stringify({
            status,
            error: event.params.error,
            failureReason: event.params.failureReason,
          }),
          callID,
          ...actorContext,
        },
      ]
    }
    if ((event.method === "turn/started" || event.method === "turn/completed") && actor) {
      const turn = isRecord(event.params) && isRecord(event.params.turn) ? event.params.turn : undefined
      const turnID = typeof turn?.id === "string" && turn.id ? turn.id : "unknown"
      if (event.method === "turn/started")
        return [{ kind: "agent", actor, state: "active", transitionID: `${actor.id}:${turnID}:started` }]
      return [
        {
          kind: "agent",
          actor,
          state: completedTurnActorState(turn?.status),
          transitionID: `${actor.id}:${turnID}:completed`,
        },
      ]
    }
    if (event.method === "thread/status/changed" && actor && isRecord(event.params)) {
      const status = isRecord(event.params.status) ? event.params.status.type : undefined
      if (status === "systemError")
        return [{ kind: "agent", actor, state: "failed", transitionID: `${actor.id}:system-error` }]
    }
    if ((event.method === "item/started" || event.method === "item/completed") && isRecord(event.params)) {
      const item = isRecord(event.params.item) ? event.params.item : undefined
      if (!item) return []
      const callID = typeof item.id === "string" ? item.id : ""
      if (event.method === "item/completed" && item.type === "agentMessage" && typeof item.text === "string") {
        const value = item.text.trim()
        return value ? [{ kind: "text", text: value, ...actorContext }] : []
      }
      if (item.type === "collabAgentToolCall") {
        if (event.method === "item/started")
          return [
            {
              kind: "tool",
              tool: `subagent.${typeof item.tool === "string" ? item.tool : "collaboration"}`,
              input: collabAgentInput(item),
              callID,
              ...actorContext,
            },
          ]
        const value = outputText(
          JSON.stringify({
            status: item.status,
            receiverThreadIds: item.receiverThreadIds,
            agentsStates: item.agentsStates,
          }),
        )
        const states = collabAgentStateActivities(item)
        return value ? [{ kind: "output", text: value, callID, ...actorContext }, ...states] : states
      }
      if (item.type === "subAgentActivity") {
        if (event.method === "item/started") return []
        const child = subAgentActivity(item, actor?.id)
        return child ? [child] : []
      }
      if (event.method === "item/started" && item.type === "commandExecution")
        return [{ kind: "tool", tool: "shell", input: { command: item.command }, callID, ...actorContext }]
      if (event.method === "item/started" && item.type === "mcpToolCall")
        return [
          {
            kind: "tool",
            tool: prettyToolName(typeof item.tool === "string" ? item.tool : "mcp"),
            input: item.arguments ?? {},
            callID,
            ...actorContext,
          },
        ]
      if (event.method === "item/completed" && (item.type === "commandExecution" || item.type === "mcpToolCall")) {
        const raw = item.error ?? item.aggregatedOutput ?? item.result
        const value = outputText(resultOutputText(raw))
        return value ? [{ kind: "output", text: value, callID, ...actorContext }] : []
      }
    }
    if (event.type === "turn.completed" && isRecord(event.usage) && typeof event.usage.output_tokens === "number") {
      return [
        {
          kind: "progress",
          usage: {
            generatedTokens: event.usage.output_tokens,
            ...(typeof event.usage.input_tokens === "number" ? { inputTokens: event.usage.input_tokens } : {}),
            ...(typeof event.usage.reasoning_output_tokens === "number"
              ? { reasoningTokens: event.usage.reasoning_output_tokens }
              : {}),
            ...(typeof event.usage.cached_input_tokens === "number"
              ? { cacheReadTokens: event.usage.cached_input_tokens }
              : {}),
            ...(typeof event.thread_id === "string" ? { scopeID: event.thread_id } : {}),
          },
        },
      ]
    }
    const item = event.item
    if (!isRecord(item)) return []
    const callID = typeof item.id === "string" ? item.id : ""
    if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
      const value = item.text.trim()
      return value ? [{ kind: "text", text: value }] : []
    }
    if (event.type === "item.started" && item.type === "command_execution") {
      return [{ kind: "tool", tool: "shell", input: { command: item.command }, callID }]
    }
    if (event.type === "item.started" && item.type === "mcp_tool_call") {
      return [
        {
          kind: "tool",
          tool: prettyToolName(typeof item.tool === "string" ? item.tool : "mcp"),
          input: item.arguments ?? {},
          callID,
        },
      ]
    }
    if (event.type === "item.completed" && (item.type === "command_execution" || item.type === "mcp_tool_call")) {
      const raw = item.error ?? item.aggregated_output ?? item.output ?? item.result
      const value = outputText(resultOutputText(raw))
      return value ? [{ kind: "output", text: value, callID }] : []
    }
    return []
  },
}

function collabAgentInput(item: Record<string, unknown>) {
  return {
    operation: item.tool,
    prompt: item.prompt,
    model: item.model,
    reasoningEffort: item.reasoningEffort,
    senderThreadId: item.senderThreadId,
    receiverThreadIds: item.receiverThreadIds,
  }
}

function appServerActor(event: Record<string, unknown>): PhaseActivityActor | undefined {
  if (!isRecord(event.params)) return undefined
  const id = event.params.threadId
  return typeof id === "string" && id ? { id } : undefined
}

function subAgentActivity(item: Record<string, unknown>, parentID?: string): PhaseActivity | undefined {
  const id = item.agentThreadId
  if (typeof id !== "string" || !id) return undefined
  const path = typeof item.agentPath === "string" ? item.agentPath.trim() : ""
  const label = path.replace(/^\/?root\/?/, "") || `subagent-${id.slice(0, 8)}`
  const state =
    item.kind === "started"
      ? "started"
      : item.kind === "interacted"
        ? "interacted"
        : item.kind === "interrupted"
          ? "interrupted"
          : undefined
  if (!state) return undefined
  const transitionID = typeof item.id === "string" && item.id ? item.id : `${id}:${state}`
  return { kind: "agent", actor: { id, label, ...(parentID ? { parentID } : {}) }, state, transitionID }
}

function completedTurnActorState(status: unknown): PhaseActivityActorState {
  if (status === "interrupted") return "interrupted"
  if (status === "failed") return "failed"
  return "completed"
}

function collabAgentStateActivities(item: Record<string, unknown>): PhaseActivity[] {
  if (!isRecord(item.agentsStates)) return []
  return Object.entries(item.agentsStates).flatMap(([id, value]) => {
    if (!id || !isRecord(value)) return []
    const state = collabAgentState(value.status)
    const callID = typeof item.id === "string" && item.id ? item.id : "collaboration"
    return state ? [{ kind: "agent", actor: { id }, state, transitionID: `${callID}:${id}:${state}` }] : []
  })
}

function collabAgentState(status: unknown): PhaseActivityActorState | undefined {
  if (status === "pendingInit") return "started"
  if (status === "running") return "active"
  if (status === "completed" || status === "shutdown") return "completed"
  if (status === "interrupted") return "interrupted"
  if (status === "errored" || status === "notFound") return "failed"
  return undefined
}

function prettyToolName(name: string): string {
  return name.replace(/^mcp__[a-z0-9-]+__/i, "")
}

const OUTPUT_MAX_LINES = 100

function outputText(text: string): string {
  const lines = text.split("\n").map((line) => line.replace(/\s+$/, ""))
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  while (lines.length > 0 && lines[0] === "") lines.shift()
  if (lines.length > OUTPUT_MAX_LINES) lines.length = OUTPUT_MAX_LINES
  return lines.join("\n")
}

// ── Tool Results Prefer Human-Readable MCP Text ───────────────────
// Codex wraps MCP output in a CallToolResult transport object. Serializing that
// wrapper escapes text newlines and makes the live activity card display
// protocol JSON instead of the tool's output. Standard text content is unwrapped
// at this boundary, while genuinely structured or unknown results retain a JSON
// fallback so information is not discarded merely for presentation.
// ──────────────────────────────────────────────────────────────
function resultOutputText(value: unknown): string {
  if (typeof value === "string") return value
  if (isRecord(value) && Array.isArray(value.content)) {
    const text = toolResultText(value.content)
    if (text) return text
  }
  return value === undefined ? "" : JSON.stringify(value)
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join("\n")
  return ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export * as SubsystemProvider from "./provider"
