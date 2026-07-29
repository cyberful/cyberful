// ── Pi Worker MCP Bridge Tests ───────────────────────────────────
// Verifies real stdio discovery, authorization, host elicitation, content
// projection, private descriptor isolation, and idempotent process cleanup.
// → cyberful/src/subsystem/pi-mcp.ts — owns the tested worker connection.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import path from "node:path"
import { connectPiMcp } from "./pi-mcp"
import type { SubsystemMcpServer } from "./subsystem"

const PRIVATE_VALUE = "must-remain-host-owned"

function fixtureServer(): SubsystemMcpServer {
  return {
    name: "pi-mcp-fixture",
    command: process.execPath,
    args: [path.join(import.meta.dir, "pi-mcp.fixture.ts")],
    env: { BUN_BE_BUN: "1" },
    privateEnv: { CYBERFUL_TEST_PRIVATE_VALUE: PRIVATE_VALUE },
  }
}

describe("Pi MCP worker bridge", () => {
  test("projects distinct root and child policies over one connection", async () => {
    let childEchoAllowed = true
    const bridge = await connectPiMcp(fixtureServer(), {
      cwd: import.meta.dir,
      isToolAllowed: (name) => name !== "filtered",
    })

    try {
      const rootTools = bridge.toolsFor({
        handoffAuthorized: true,
        isToolAllowed: () => true,
      })
      const childTools = bridge.toolsFor({
        handoffAuthorized: false,
        isToolAllowed: (name) => name !== "echo" || childEchoAllowed,
      })
      expect(rootTools.map((tool) => tool.name)).toEqual(["echo", "failure", "question", "handoff"])
      expect(childTools.map((tool) => tool.name)).toEqual(["echo", "failure", "question"])

      const rootEcho = rootTools.find((tool) => tool.name === "echo")
      const rootHandoff = rootTools.find((tool) => tool.name === "handoff")
      const childEcho = childTools.find((tool) => tool.name === "echo")
      const childFailure = childTools.find((tool) => tool.name === "failure")
      expect(rootEcho).toBeDefined()
      expect(rootHandoff).toBeDefined()
      expect(childEcho).toBeDefined()
      expect(childFailure).toBeDefined()
      expect(rootEcho).not.toBe(childEcho)

      const result = await childEcho!.execute("call-1", { value: "hello" })
      expect(result.content).toEqual([
        { type: "text", text: "echo: hello" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        { type: "text", text: "MCP audio (audio/wav, base64):\nYXVkaW8=" },
        { type: "text", text: "MCP resource fixture://text:\nresource text" },
        {
          type: "text",
          text: "MCP resource fixture://blob (application/octet-stream), base64:\nYmxvYg==",
        },
        {
          type: "text",
          text: 'MCP resource link: {\n  "uri": "fixture://linked",\n  "name": "linked fixture",\n  "mimeType": "text/plain"\n}',
        },
        { type: "text", text: 'MCP structured output:\n{\n  "status": "complete"\n}' },
      ])
      expect(result.details).toEqual({
        serverName: "pi-mcp-fixture",
        toolName: "echo",
        isError: false,
      })
      expect(JSON.stringify(result)).not.toContain(PRIVATE_VALUE)
      await expect(childFailure!.execute("call-2", { value: "bad" })).rejects.toThrow("fixture failure: bad")
      expect(await rootHandoff!.execute("call-handoff", { value: "verify" })).toEqual({
        content: [{ type: "text", text: "handoff: verify" }],
        details: {
          serverName: "pi-mcp-fixture",
          toolName: "handoff",
          isError: false,
        },
      })

      childEchoAllowed = false
      await expect(childEcho!.execute("call-3", { value: "stale-child-reference" })).rejects.toThrow(
        "MCP tool echo is not authorized for this agent run",
      )
      expect((await rootEcho!.execute("call-4", { value: "root-remains-authorized" })).content[0]).toEqual({
        type: "text",
        text: "echo: root-remains-authorized",
      })
    } finally {
      const firstClose = bridge.close()
      expect(bridge.close()).toBe(firstClose)
      await firstClose
    }
  })

  test("routes accepted, declined, and aborted elicitations to the host selector", async () => {
    let callCount = 0
    let pendingSignal: AbortSignal | undefined
    const pendingStarted = Promise.withResolvers<void>()
    const pendingAborted = Promise.withResolvers<void>()
    const bridge = await connectPiMcp(fixtureServer(), {
      cwd: import.meta.dir,
      askQuestion: async (_questions, signal) => {
        callCount += 1
        if (callCount === 1) return [["Proceed"]]
        if (callCount === 2) throw { _tag: "QuestionRejectedError" }
        pendingSignal = signal
        pendingStarted.resolve()
        return new Promise((_resolve, reject) => {
          if (signal.aborted) return reject(signal.reason)
          signal.addEventListener(
            "abort",
            () => {
              pendingAborted.resolve()
              reject(signal.reason)
            },
            { once: true },
          )
        })
      },
    })

    try {
      const question = bridge
        .toolsFor({ handoffAuthorized: false, isToolAllowed: () => true })
        .find((tool) => tool.name === "question")
      expect(question).toBeDefined()

      const accepted = await question!.execute("question-accept", { value: "accept" })
      expect(accepted.content[0]).toEqual({
        type: "text",
        text: '{"action":"accept","content":{"q0":"[\\"Proceed\\"]"},"humanDecision":true}',
      })
      const declined = await question!.execute("question-decline", { value: "decline" })
      expect(declined.content[0]).toEqual({
        type: "text",
        text: '{"action":"decline","humanDecision":true}',
      })
      await expect(question!.execute("question-invalid", { value: "invalid-schema" })).rejects.toThrow(
        "Elicitation form does not match its Cyberful approval envelope",
      )
      expect(callCount).toBe(2)

      const abort = new AbortController()
      const running = question!.execute("question-abort", { value: "wait" }, abort.signal)
      await pendingStarted.promise
      abort.abort(new Error("test cancelled"))
      await expect(running).rejects.toThrow()
      await pendingAborted.promise
      expect(pendingSignal?.aborted).toBe(true)
    } finally {
      await bridge.close()
    }
  })

  test("cancels gateway elicitation when no human selector belongs to the worker", async () => {
    const bridge = await connectPiMcp(fixtureServer(), { cwd: import.meta.dir })
    try {
      const question = bridge
        .toolsFor({ handoffAuthorized: false, isToolAllowed: () => true })
        .find((tool) => tool.name === "question")
      expect(question).toBeDefined()
      const result = await question!.execute("question-cancel", { value: "cancel" })
      expect(result.content[0]).toEqual({
        type: "text",
        text: '{"action":"cancel","humanDecision":false}',
      })
      expect(JSON.stringify(result)).not.toContain(PRIVATE_VALUE)
    } finally {
      await bridge.close()
    }
  })
})
