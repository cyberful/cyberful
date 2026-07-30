// ── Model-Assisted Context Checkpoint Tests ─────────────────────
// Verifies bounded free-form notes, structured reference validation, durable
//   persistence, and provider-only projection of semantic checkpoints.
// → cyberful/src/subsystem/pi-semantic-compaction.ts — owns the checkpoint format.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
  buildRotationHistory,
  parseModelCheckpoint,
  persistModelCheckpoint,
  projectSemanticContext,
} from "./pi-semantic-compaction"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe("model-assisted context checkpoints", () => {
  test("persists advisory working notes beside validated structured state", async () => {
    const workarea = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "cyberful-semantic-compaction-")),
    )
    temporaryDirectories.push(workarea)
    const sourceMessages: AgentMessage[] = [
      { role: "user", content: "Continue hypothesis HYP-7 from evidence/api-response.json.", timestamp: 1 },
    ]
    const checkpoint = parseModelCheckpoint({
      text: JSON.stringify({
        working_notes:
          "The tenant boundary remains the most promising path. Avoid repeating the already negative role-only comparison.",
        structured_state: {
          objective: "Verify the tenant boundary.",
          phase: "recon",
          current_state: "The role-only comparison is complete; tenant ownership remains open.",
          scope_and_constraints: ["Authorized sandbox only."],
          decisions: [
            {
              decision: "Prioritize tenant ownership.",
              rationale: "The role-only comparison was negative.",
            },
          ],
          verified_facts: ["The role-only comparison was negative."],
          hypotheses: [{ id: "HYP-7", status: "TESTING", note: "Compare tenant ownership." }],
          findings: [],
          tests_completed: ["Role-only comparison."],
          tests_pending: ["Tenant ownership comparison."],
          activities_completed: ["Compared role-only behavior."],
          activities_open: ["Compare tenant ownership."],
          blockers: [],
          errors_and_failed_attempts: ["Role-only comparison did not discriminate access."],
          mistakes_not_to_repeat: ["Do not repeat the identical role-only comparison."],
          evidence_refs: ["evidence/api-response.json"],
          next_actions: ["Run the tenant ownership comparison."],
        },
        what_i_would_do_next: "Reopen both profiles and compare the same object identifier.",
      }),
      sourceMessages,
      sanitize: (text) => text,
    })
    const projection = await persistModelCheckpoint({
      checkpoint,
      workarea,
      runID: "run-semantic",
      generation: 1,
      sourceMessageCount: sourceMessages.length,
      sourceEstimatedTokens: 12_345,
      provider: "main",
      model: "test-model",
      reasoningEffort: "medium",
    })

    const projected = projectSemanticContext(sourceMessages, projection)
    expect(projected).toHaveLength(1)
    expect(projected[0]?.role).toBe("user")
    const checkpointMessage = projected[0]
    if (checkpointMessage?.role !== "user")
      throw new Error("Semantic projection did not produce a host-owned user checkpoint")
    expect(checkpointMessage.content).toContain('"working_notes"')
    expect(projection.artifact.path).toStartWith("raw/context-summaries/")
    expect(
      JSON.parse(await readFile(path.join(workarea, projection.artifact.path), "utf8")),
    ).toMatchObject({
      version: 2,
      generation: 1,
      sourceMessageCount: 1,
      sourceEstimatedTokens: 12_345,
      checkpoint: {
        structured_state: { objective: "Verify the tenant boundary." },
      },
    })
  })

  test("rejects a model-invented hypothesis reference", () => {
    expect(() =>
      parseModelCheckpoint({
        text: JSON.stringify({
          working_notes: "Keep the supported path.",
          structured_state: {
            objective: "Continue supported testing.",
            phase: "recon",
            current_state: "No supported hypothesis is open.",
            scope_and_constraints: [],
            decisions: [],
            verified_facts: [],
            hypotheses: [{ id: "HYP-INVENTED", status: "OPEN", note: "Unsupported." }],
            findings: [],
            tests_completed: [],
            tests_pending: [],
            activities_completed: [],
            activities_open: [],
            blockers: [],
            errors_and_failed_attempts: [],
            mistakes_not_to_repeat: [],
            evidence_refs: [],
            next_actions: [],
          },
          what_i_would_do_next: "Continue only from supported evidence.",
        }),
        sourceMessages: [{ role: "user", content: "No hypothesis identifiers.", timestamp: 1 }],
        sanitize: (text) => text,
      }),
    ).toThrow("is not present in source context")
  })

  test("replaces older checkpoints while preserving the active turn and complete tool chain", () => {
    const checkpoint = {
      role: "user",
      content: "[Host-owned semantic context checkpoint]\nnew",
      timestamp: 10,
    } as const
    const history = buildRotationHistory({
      messages: [
        {
          role: "user",
          content: "[Host-owned semantic context checkpoint]\nold",
          timestamp: 1,
        },
        { role: "user", content: "Historical operator constraint.", timestamp: 2 },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "evidence",
              arguments: {},
            },
          ],
          api: "openai-codex-responses",
          provider: "main",
          model: "test",
          stopReason: "toolUse",
          timestamp: 3,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "evidence",
          content: [{ type: "text", text: "complete evidence" }],
          isError: false,
          timestamp: 4,
        },
        { role: "user", content: "Current operator instruction.", timestamp: 5 },
        {
          role: "assistant",
          content: [{ type: "text", text: "Current work." }],
          api: "openai-codex-responses",
          provider: "main",
          model: "test",
          stopReason: "stop",
          timestamp: 6,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      ],
      checkpoint,
    })

    expect(history.messages[0]).toBe(checkpoint)
    expect(
      history.messages.filter(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("[Host-owned semantic context checkpoint]"),
      ),
    ).toHaveLength(1)
    expect(history.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
      "toolResult",
      "user",
      "assistant",
    ])
  })

  test("rejects an atomic replacement that would orphan a tool result", () => {
    expect(() =>
      buildRotationHistory({
        messages: [
          { role: "user", content: "Continue the active test.", timestamp: 1 },
          {
            role: "toolResult",
            toolCallId: "missing-call",
            toolName: "evidence",
            content: [{ type: "text", text: "orphaned evidence" }],
            isError: false,
            timestamp: 2,
          },
        ],
        checkpoint: {
          role: "user",
          content: "[Host-owned semantic context checkpoint]\nvalidated",
          timestamp: 3,
        },
      }),
    ).toThrow("orphan tool result")
  })
})
