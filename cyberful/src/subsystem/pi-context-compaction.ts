// ── Pi AgentRun Context Compaction ──────────────────────────────
// Projects long-lived Pi transcripts into bounded provider context while
//   preserving complete tool results as owner-only workarea artifacts.
// → cyberful/src/subsystem/pi-agent.ts — installs the projection on every AgentRun.
// → cyberful/src/workarea.ts — owns symlink-safe artifact persistence.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import {
  estimateTokens,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core"
import type { ToolResultMessage } from "@earendil-works/pi-ai"
import type { Settings } from "@/config/settings"
import { replaceWorkareaFile } from "@/workarea"

const MIN_SAFETY_MARGIN_TOKENS = 8_192
const MAX_SAFETY_MARGIN_TOKENS = 32_768
const SAFETY_MARGIN_RATIO = 0.05
const PROACTIVE_RECENT_RESULTS = 6
const EMERGENCY_RECENT_RESULTS = 2
const PROACTIVE_EXCERPT_CHARS = 2_400
const EMERGENCY_EXCERPT_CHARS = 800
const ARTIFACT_ROOT = "raw/context-tool-results"
const SEMANTIC_TOOL_RESULTS = new Set([
  "delegate_task",
  "finding",
  "handoff",
  "host_fallback_delegation",
  "novelty",
  "request_fallback_delegation",
  "test_object",
])

export type ContextCompactionMode = "proactive" | "emergency"

export interface ContextArtifactReference {
  readonly path: string
  readonly sha256: string
}

export interface ContextProjectionEntry {
  readonly artifactKey: string
  readonly artifact: ContextArtifactReference
  readonly proactive: ToolResultMessage
  readonly emergency: ToolResultMessage
}

export interface ContextCompactionNeed {
  readonly mode: ContextCompactionMode
  readonly estimatedTokensBefore: number
  readonly triggerTokens: number
  readonly targetTokens: number
}

export interface ContextCompactionResult {
  readonly messages: AgentMessage[]
  readonly estimatedTokensBefore: number
  readonly estimatedTokensAfter: number
  readonly triggerTokens: number
  readonly messagesRemoved: 0
  readonly toolResultsVirtualized: number
  readonly artifactsPreserved: number
  readonly persistenceFailures: number
}

interface Candidate {
  readonly index: number
  readonly toolCallID: string
  readonly priority: number
  readonly savings: number
  readonly artifactKey: string
  readonly artifact: ContextArtifactReference
  readonly serialized: string
  readonly projection: ContextProjectionEntry
}

function serialized(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined"
  } catch {
    return "[unserializable]"
  }
}

function artifactJson(input: {
  readonly runID: string
  readonly message: ToolResultMessage
}): string {
  const seen = new WeakSet<object>()
  const replacer = (_key: string, value: unknown): unknown => {
    if (typeof value === "bigint") return value.toString()
    if (value instanceof Error)
      return {
        name: value.name,
        message: value.message,
        ...(value.stack ? { stack: value.stack } : {}),
      }
    if (typeof value !== "object" || value === null) return value
    if (seen.has(value)) return "[Circular]"
    seen.add(value)
    return value
  }
  return `${JSON.stringify(
    {
      version: 1,
      runID: input.runID,
      toolCallID: input.message.toolCallId,
      toolName: input.message.toolName,
      isError: input.message.isError,
      timestamp: input.message.timestamp,
      content: input.message.content,
      details: input.message.details,
      usage: input.message.usage,
      addedToolNames: input.message.addedToolNames,
    },
    replacer,
    2,
  )}\n`
}

function compactExcerpt(message: ToolResultMessage, limit: number): string {
  const text = message.content
    .map((content) =>
      content.type === "text"
        ? content.text
        : `[image omitted from provider context: ${content.mimeType}, ${content.data.length} encoded characters]`,
    )
    .join("\n")
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.6)
  const tail = limit - head
  return `${text.slice(0, head)}\n…[middle omitted from provider context]…\n${text.slice(-tail)}`
}

function artifactPath(runID: string, message: ToolResultMessage, sha256: string): string {
  const run = createHash("sha256").update(runID).digest("hex").slice(0, 16)
  const call = createHash("sha256").update(message.toolCallId).digest("hex").slice(0, 16)
  return `${ARTIFACT_ROOT}/${run}/${call}-${sha256.slice(0, 20)}.json`
}

function virtualizedMessage(
  message: ToolResultMessage,
  artifact: ContextArtifactReference,
  bytes: number,
  excerptChars: number,
): ToolResultMessage {
  const excerpt = compactExcerpt(message, excerptChars)
  return {
    ...message,
    content: [
      {
        type: "text",
        text: [
          `[Historical tool result virtualized: ${message.toolName}]`,
          `State: ${message.isError ? "error" : "success"}`,
          `Complete result: ${artifact.path}`,
          `SHA-256: ${artifact.sha256}`,
          `Stored bytes: ${bytes}`,
          "The complete result remains available without truncation. Read only the required ranges from the workarea artifact; inside cyberful-os use /workspace/ followed by the path above.",
          "",
          "Useful excerpt:",
          excerpt || "(no textual content; inspect the artifact for structured or image content)",
        ].join("\n"),
      },
    ],
  }
}

function toolDefinitionTokens(tools: readonly AgentTool[]): number {
  return Math.ceil(
    tools.reduce(
      (total, tool) =>
        total +
        serialized({
          name: tool.name,
          label: tool.label,
          description: tool.description,
          parameters: tool.parameters,
        }).length,
      0,
    ) / 4,
  )
}

export function projectAgentContext(
  messages: readonly AgentMessage[],
  projections: ReadonlyMap<string, ContextProjectionEntry>,
  mode: ContextCompactionMode,
): AgentMessage[] {
  if (projections.size === 0) return [...messages]
  return messages.map((message) => {
    if (message.role !== "toolResult") return message
    const projection = projections.get(message.toolCallId)
    return projection?.[mode] ?? message
  })
}

export function estimateAgentContextTokens(input: {
  readonly systemPrompt: string
  readonly messages: readonly AgentMessage[]
  readonly tools: readonly AgentTool[]
}): number {
  return (
    Math.ceil(input.systemPrompt.length / 4) +
    toolDefinitionTokens(input.tools) +
    input.messages.reduce((total, message) => total + estimateTokens(message), 0)
  )
}

export function contextCompactionNeed(input: {
  readonly mode: ContextCompactionMode
  readonly policy: Settings.CompactionPolicy
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly estimatedTokens: number
  readonly hasToolResults: boolean
}): ContextCompactionNeed | undefined {
  if (!input.policy.enabled || !input.hasToolResults) return
  const ratioLimit = Math.floor((input.contextWindow * input.policy.trigger_percentage) / 100)
  const safetyMargin = Math.max(
    MIN_SAFETY_MARGIN_TOKENS,
    Math.min(MAX_SAFETY_MARGIN_TOKENS, Math.floor(input.contextWindow * SAFETY_MARGIN_RATIO)),
  )
  const outputAwareLimit = input.contextWindow - input.maxOutputTokens - safetyMargin
  const triggerTokens = Math.max(1, Math.min(ratioLimit, outputAwareLimit > 0 ? outputAwareLimit : ratioLimit))
  if (input.mode === "proactive" && input.estimatedTokens <= triggerTokens) return
  const targetTokens =
    input.mode === "emergency"
      ? Math.max(1, Math.min(Math.floor(triggerTokens * 0.6), Math.floor(input.contextWindow * 0.45)))
      : Math.max(1, Math.floor(triggerTokens * 0.72))
  return {
    mode: input.mode,
    estimatedTokensBefore: input.estimatedTokens,
    triggerTokens,
    targetTokens,
  }
}

function candidates(input: {
  readonly messages: readonly AgentMessage[]
  readonly runID: string
  readonly mode: ContextCompactionMode
}): Candidate[] {
  const toolResults = input.messages.flatMap((message, index) =>
    message.role === "toolResult" ? [{ index, message }] : [],
  )
  const recentCount = input.mode === "emergency" ? EMERGENCY_RECENT_RESULTS : PROACTIVE_RECENT_RESULTS
  const recentStart = Math.max(0, toolResults.length - recentCount)
  const excerptChars = input.mode === "emergency" ? EMERGENCY_EXCERPT_CHARS : PROACTIVE_EXCERPT_CHARS

  return toolResults
    .flatMap(({ index, message }, position) => {
      const full = artifactJson({ runID: input.runID, message })
      const sha256 = createHash("sha256").update(full).digest("hex")
      const artifact = {
        path: artifactPath(input.runID, message, sha256),
        sha256,
      }
      const bytes = Buffer.byteLength(full)
      const projected = virtualizedMessage(message, artifact, bytes, excerptChars)
      const savings = estimateTokens(message) - estimateTokens(projected)
      if (savings <= 0) return []

      const recent = position >= recentStart
      const semantic = SEMANTIC_TOOL_RESULTS.has(message.toolName)
      const latest = position === toolResults.length - 1
      const priority = latest ? 4 : recent ? (semantic ? 3 : 2) : semantic ? 1 : 0
      return [
        {
          index,
          toolCallID: message.toolCallId,
          priority,
          savings,
          artifactKey: `${message.toolCallId}:${sha256}`,
          artifact,
          serialized: full,
          projection: {
            artifactKey: `${message.toolCallId}:${sha256}`,
            artifact,
            proactive: virtualizedMessage(message, artifact, bytes, PROACTIVE_EXCERPT_CHARS),
            emergency: virtualizedMessage(message, artifact, bytes, EMERGENCY_EXCERPT_CHARS),
          },
        },
      ]
    })
    .toSorted(
      (left, right) =>
        left.priority - right.priority ||
        right.savings - left.savings ||
        left.index - right.index,
    )
}

// ── Provider Projection Never Becomes The Evidence Store ────────
// The Agent owns an unmodified transcript so tool execution, auditing, and
// recovery always retain the original result. Only a provider-bound copy is
// changed. Every selected result is first written through the canonical
// workarea boundary; a failed write leaves that result verbatim in context.
// Assistant tool calls remain adjacent to results with the same call IDs, while
// user messages, assistant text, findings, handoffs, and child-run structure
// remain untouched.
//
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────
export async function compactAgentContext(input: {
  readonly need: ContextCompactionNeed
  readonly messages: readonly AgentMessage[]
  readonly systemPrompt: string
  readonly tools: readonly AgentTool[]
  readonly workarea: string
  readonly runID: string
  readonly artifacts: Map<string, ContextArtifactReference>
  readonly projections: Map<string, ContextProjectionEntry>
  readonly signal?: AbortSignal
}): Promise<ContextCompactionResult> {
  const projected = projectAgentContext(input.messages, input.projections, input.need.mode)
  const available = candidates({
    messages: input.messages,
    runID: input.runID,
    mode: input.need.mode,
  }).filter((candidate) => !input.projections.has(candidate.toolCallID))
  const selected: Candidate[] = []
  let estimated = input.need.estimatedTokensBefore

  for (const candidate of available) {
    if (selected.length > 0 && estimated <= input.need.targetTokens) break
    selected.push(candidate)
    estimated = Math.max(0, estimated - candidate.savings)
  }

  const reused =
    input.need.mode === "emergency"
      ? input.messages.flatMap((message) =>
          message.role === "toolResult" && input.projections.has(message.toolCallId)
            ? [input.projections.get(message.toolCallId)!]
            : [],
        )
      : []
  if (selected.length === 0 && !input.signal?.aborted && reused.length > 0)
    return {
      messages: projected,
      estimatedTokensBefore: input.need.estimatedTokensBefore,
      estimatedTokensAfter: input.need.estimatedTokensBefore,
      triggerTokens: input.need.triggerTokens,
      messagesRemoved: 0,
      toolResultsVirtualized: reused.length,
      artifactsPreserved: new Set(reused.map((entry) => entry.artifact.path)).size,
      persistenceFailures: 0,
    }

  if (input.signal?.aborted || selected.length === 0)
    return {
      messages: projected,
      estimatedTokensBefore: input.need.estimatedTokensBefore,
      estimatedTokensAfter: input.need.estimatedTokensBefore,
      triggerTokens: input.need.triggerTokens,
      messagesRemoved: 0,
      toolResultsVirtualized: 0,
      artifactsPreserved: 0,
      persistenceFailures: selected.length === 0 ? 1 : selected.length,
    }

  const persisted = await Promise.allSettled(
    selected.map(async (candidate) => {
      if (!input.artifacts.has(candidate.artifactKey))
        await replaceWorkareaFile(input.workarea, candidate.artifact.path, candidate.serialized, { mode: 0o600 })
      input.artifacts.set(candidate.artifactKey, candidate.artifact)
      input.projections.set(candidate.toolCallID, candidate.projection)
      return candidate
    }),
  )

  const successful = persisted.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
  for (const candidate of successful)
    projected[candidate.index] = candidate.projection[input.need.mode]
  const estimatedTokensAfter = estimateAgentContextTokens({
    systemPrompt: input.systemPrompt,
    messages: projected,
    tools: input.tools,
  })

  return {
    messages: projected,
    estimatedTokensBefore: input.need.estimatedTokensBefore,
    estimatedTokensAfter,
    triggerTokens: input.need.triggerTokens,
    messagesRemoved: 0,
    toolResultsVirtualized: successful.length,
    artifactsPreserved: new Set(successful.map((candidate) => candidate.artifact.path)).size,
    persistenceFailures: persisted.length - successful.length,
  }
}

export * as PiContextCompaction from "./pi-context-compaction"
