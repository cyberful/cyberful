// ── Pi AgentRun Context Compaction Tests ────────────────────────
// Protects output-aware triggering, complete artifact persistence, and
//   provider-only virtualization without changing semantic message structure.
// → cyberful/src/subsystem/pi-context-compaction.ts — owns the projection.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai"
import {
  compactAgentContext,
  contextCompactionNeed,
  estimateAgentContextTokens,
  projectAgentContext,
  type ContextArtifactReference,
  type ContextProjectionEntry,
} from "./pi-context-compaction"

const temporaryDirectories: string[] = []

async function temporaryWorkarea() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-context-compaction-")))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function user(content: string, timestamp: number): UserMessage {
  return { role: "user", content, timestamp }
}

function assistant(
  timestamp: number,
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-codex-responses",
    provider: "main",
    model: "test",
    content,
    usage: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
    timestamp,
  }
}

function toolResult(callID: string, toolName: string, text: string, timestamp: number): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: callID,
    toolName,
    content: [{ type: "text", text }],
    details: { complete: true },
    isError: false,
    timestamp,
  }
}

describe("Pi AgentRun context compaction", () => {
  test("triggers at 75 percent and targets 35 percent of the operational window", () => {
    const policy = { enabled: true, trigger_percentage: 75, target_percentage: 35 }
    expect(
      contextCompactionNeed({
        mode: "proactive",
        policy,
        operationalContextWindow: 256_000,
        estimatedTokens: 191_999,
      }),
    ).toBeUndefined()

    expect(
      contextCompactionNeed({
        mode: "proactive",
        policy,
        operationalContextWindow: 256_000,
        estimatedTokens: 192_000,
      }),
    ).toMatchObject({
      estimatedTokensBefore: 192_000,
      triggerTokens: 192_000,
      targetTokens: 89_600,
    })
  })

  test("keeps semantic messages and call-result pairs while saving the complete historical result", async () => {
    const workarea = await temporaryWorkarea()
    const callID = "call-historical"
    const completeOutput = `opening evidence\n${"target-observation-".repeat(8_000)}\nclosing evidence`
    const messages: AgentMessage[] = [
      user("Preserve the original authorized scope and objective.", 1),
      assistant(2, [
        { type: "text", text: "Decision: retain the hypothesis until the finding evidence is verified." },
        { type: "toolCall", id: callID, name: "shell", arguments: { command: "bounded evidence collection" } },
      ]),
      toolResult(callID, "shell", completeOutput, 3),
      assistant(4, [
        { type: "toolCall", id: "finding-call", name: "finding", arguments: { operation: "record" } },
      ]),
      toolResult("finding-call", "finding", "Finding SUSPECTED with evidence reference.", 5),
    ]
    const estimatedTokens = estimateAgentContextTokens({
      systemPrompt: "Immutable Cyberful scope.",
      messages,
      tools: [],
    })
    const need = contextCompactionNeed({
      mode: "emergency",
      policy: { enabled: true, trigger_percentage: 75, target_percentage: 35 },
      operationalContextWindow: 256_000,
      estimatedTokens,
    })
    if (!need) throw new Error("Emergency compaction should be available for a transcript with tool results")

    const artifacts = new Map<string, ContextArtifactReference>()
    const projections = new Map<string, ContextProjectionEntry>()
    const result = await compactAgentContext({
      need,
      messages,
      systemPrompt: "Immutable Cyberful scope.",
      tools: [],
      workarea,
      runID: "run-context-test",
      artifacts,
      projections,
    })

    expect(result.messages).toHaveLength(messages.length)
    expect(result.messages[0]).toEqual(messages[0])
    expect(result.messages[1]).toEqual(messages[1])
    expect(result.messages[3]).toEqual(messages[3])
    expect(result.messages[4]).toEqual(messages[4])
    expect(result.messagesRemoved).toBe(0)
    expect(result.toolResultsVirtualized).toBe(1)
    expect(result.artifactsPreserved).toBe(1)
    expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore)

    const projected = result.messages[2]
    expect(projected.role).toBe("toolResult")
    if (projected.role !== "toolResult") throw new Error("Historical tool result was not preserved as a pair")
    expect(projected.toolCallId).toBe(callID)
    expect(projected.toolName).toBe("shell")
    const projectedText = projected.content[0]?.type === "text" ? projected.content[0].text : ""
    const relativePath = /^Complete result: (.+)$/m.exec(projectedText)?.[1]
    expect(relativePath).toStartWith("raw/context-tool-results/")
    if (!relativePath) throw new Error("Virtualized result did not name its complete artifact")

    const artifactPath = path.join(workarea, relativePath)
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
      readonly toolCallID: string
      readonly content: readonly [{ readonly type: string; readonly text: string }]
    }
    expect(artifact.content[0]?.text).toBe(completeOutput)
    expect(artifact.toolCallID).toBe(callID)
    if (process.platform !== "win32") expect((await stat(artifactPath)).mode & 0o777).toBe(0o600)

    const nextTurn = [...messages, assistant(6, [{ type: "text", text: "Continue with the preserved evidence." }])]
    const reused = projectAgentContext(nextTurn, projections, "proactive")
    const reusedResult = reused[2]
    expect(reusedResult.role).toBe("toolResult")
    if (reusedResult.role !== "toolResult") throw new Error("Saved projection was not reused")
    expect(textFromToolResult(reusedResult)).toContain(relativePath)
    expect(projections.size).toBe(1)
  })

  test("reports exhausted candidates as a no-op instead of a persistence failure", async () => {
    const workarea = await temporaryWorkarea()
    const messages: AgentMessage[] = [
      user("Keep this bounded context.", 1),
      assistant(2, [{ type: "toolCall", id: "small-call", name: "probe", arguments: {} }]),
      toolResult("small-call", "probe", "small result", 3),
    ]

    const result = await compactAgentContext({
      need: {
        mode: "proactive",
        estimatedTokensBefore: 10_000,
        triggerTokens: 9_000,
        targetTokens: 6_000,
      },
      messages,
      systemPrompt: "Immutable Cyberful scope.",
      tools: [],
      workarea,
      runID: "run-noop-test",
      artifacts: new Map(),
      projections: new Map(),
    })

    expect(result).toMatchObject({
      outcome: "noop",
      reason: "no_candidates",
      toolResultsVirtualized: 0,
      artifactsPreserved: 0,
      persistenceFailures: 0,
    })
    expect(result.messages).toEqual(messages)
  })
})

function textFromToolResult(message: ToolResultMessage): string {
  return message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("\n")
}
