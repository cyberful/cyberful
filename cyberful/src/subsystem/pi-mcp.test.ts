// ── Pi Worker MCP Bridge Tests ───────────────────────────────────
// Verifies real stdio discovery, authorization, host elicitation, content
// projection, private descriptor isolation, diagnostic classification, and
// idempotent process cleanup.
// → cyberful/src/subsystem/pi-mcp.ts — owns the tested worker connection.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { connectPiMcp, hypothesisDetails } from "./pi-mcp"
import { SubsystemPhaseBudgetClock, type SuspensionCause } from "./phase-budget-clock"
import { RUNTIME_DIAGNOSTICS_PATH, RuntimeDiagnosticRecorder } from "./runtime-diagnostics"
import type { SubsystemMcpServer } from "./subsystem"

const PRIVATE_VALUE = "must-remain-host-owned"

function fixtureServer(options?: { readonly stderrLine?: string; readonly startupDelayMs?: number }): SubsystemMcpServer {
  return {
    name: "pi-mcp-fixture",
    command: process.execPath,
    args: [path.join(import.meta.dir, "pi-mcp.fixture.ts")],
    env: { BUN_BE_BUN: "1" },
    privateEnv: {
      CYBERFUL_TEST_PRIVATE_VALUE: PRIVATE_VALUE,
      ...(options?.stderrLine ? { CYBERFUL_TEST_STDERR_LINE: options.stderrLine } : {}),
      ...(options?.startupDelayMs === undefined
        ? {}
        : { CYBERFUL_TEST_STARTUP_DELAY_MS: String(options.startupDelayMs) }),
    },
  }
}

describe("Pi MCP worker bridge", () => {
  test("uses an explicit bounded gateway initialization timeout", async () => {
    await expect(
      connectPiMcp(fixtureServer({ startupDelayMs: 100 }), {
        cwd: import.meta.dir,
        initializationTimeoutMs: 25,
      }),
    ).rejects.toThrow("Failed to initialize MCP gateway pi-mcp-fixture")

    const bridge = await connectPiMcp(fixtureServer({ startupDelayMs: 100 }), {
      cwd: import.meta.dir,
      initializationTimeoutMs: 1_000,
    })
    await bridge.close()
  })

  test("projects typed research closeout metadata without exposing the raw envelope", () => {
    const details = hypothesisDetails("hypothesis", {
      content: [{
        type: "text",
        text: JSON.stringify({ outcome: "exhausted", activeBlockingHypotheses: 0 }),
      }],
      _meta: {
        "cyberful.dev/research-closeout": {
          version: 1,
          webTarget: true,
          unusedProfiles: [3, 2, 2],
          coverageCandidateCount: 9,
          coverageCandidateSamples: Array.from({ length: 10 }, (_, index) => `https://example.test/route-${index}`),
          collectorDegraded: false,
        },
        "private.raw.metadata": "must not be projected",
      },
    })
    expect(details).toEqual({
      synthesisOutcome: "exhausted",
      activeBlockingHypotheses: 0,
      researchCloseout: {
        version: 1,
        webTarget: true,
        unusedProfiles: [2, 3],
        coverageCandidateCount: 9,
        coverageCandidateSamples: Array.from({ length: 8 }, (_, index) => `https://example.test/route-${index}`),
        collectorDegraded: false,
      },
    })
    expect(JSON.stringify(details)).not.toContain("private.raw.metadata")
  })

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
        actor: {
          runID: "root-run-1",
          displayName: "root",
          kind: "root",
        },
      })
      const childTools = bridge.toolsFor({
        handoffAuthorized: false,
        isToolAllowed: (name) => name !== "echo" || childEchoAllowed,
        actor: {
          runID: "child-run-1",
          parentID: "root-run-1",
          displayName: "child",
          kind: "subagent",
        },
      })
      expect(rootTools.map((tool) => tool.name)).toEqual([
        "echo",
        "failure",
        "target_cooldown",
        "test_object",
        "question",
        "agent_browser_close",
        "handoff",
      ])
      expect(childTools.map((tool) => tool.name)).toEqual([
        "echo",
        "failure",
        "target_cooldown",
        "test_object",
        "question",
        "agent_browser_close",
      ])

      const rootEcho = rootTools.find((tool) => tool.name === "echo")
      const rootHandoff = rootTools.find((tool) => tool.name === "handoff")
      const childEcho = childTools.find((tool) => tool.name === "echo")
      const childFailure = childTools.find((tool) => tool.name === "failure")
      expect(rootEcho).toBeDefined()
      expect(rootHandoff).toBeDefined()
      expect(childEcho).toBeDefined()
      expect(childFailure).toBeDefined()
      expect(rootTools.find((tool) => tool.name === "agent_browser_close")).toMatchObject({ deferLoading: false })
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
      expect((await childEcho!.execute("call-meta", { value: "actor-meta" })).content[0]).toEqual({
        type: "text",
        text: JSON.stringify({
          runID: "child-run-1",
          role: "subagent",
          parentRunID: "root-run-1",
          toolCallID: "call-meta",
        }),
      })
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

  test("recovers a delegated test-object ledger through the hidden host action", async () => {
    const bridge = await connectPiMcp(fixtureServer(), { cwd: import.meta.dir })
    try {
      expect(await bridge.recoverTestObjects({ fromRunID: "child-7" })).toEqual([
        {
          id: "object-child-7",
          kind: "temporary_record",
          label: "fixture record",
          state: "cleaned",
          phase: "exploit",
          evidencePath: "raw/evidence/fixture.json",
          evidenceExists: false,
        },
      ])
      await expect(
        bridge.releaseBrowserOwner({
          runID: "child-7",
          parentID: "root-1",
          displayName: "child",
          kind: "subagent",
        }),
      ).resolves.toBeUndefined()
    } finally {
      await bridge.close()
    }
  })

  test("suspends the shared phase budget only for target cooldown calls", async () => {
    const observed: string[] = []
    const clock = SubsystemPhaseBudgetClock.create({
      deadlineAt: Date.now() + 60_000,
      retryCompensationCapMs: 30_000,
    })
    const budgetClock = {
      ...clock,
      wait: async <T>(cause: SuspensionCause, operation: () => Promise<T>) => {
        observed.push(cause)
        return clock.wait(cause, operation)
      },
    }
    const bridge = await connectPiMcp(fixtureServer(), { cwd: import.meta.dir, budgetClock })
    try {
      const tools = bridge.toolsFor({ handoffAuthorized: false, isToolAllowed: () => true })
      const echo = tools.find((tool) => tool.name === "echo")
      const cooldown = tools.find((tool) => tool.name === "target_cooldown")
      expect(echo).toBeDefined()
      expect(cooldown).toBeDefined()

      await echo!.execute("ordinary-call", { value: "ordinary" })
      await cooldown!.execute("cooldown-call", { value: "wait" })

      expect(observed).toEqual(["target_cooldown"])
    } finally {
      await bridge.close()
      clock.close()
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

  test("does not reinterpret successful tool output as a runtime warning", async () => {
    const workarea = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-mcp-diagnostics-")))
    const diagnostics = new RuntimeDiagnosticRecorder({
      workarea,
      sessionID: "session-1",
      workflow: "bug-bounty",
      phase: "recon",
      attempt: 1,
    })
    const bridge = await connectPiMcp(fixtureServer(), {
      cwd: import.meta.dir,
      diagnostics,
    })
    try {
      const echo = bridge
        .toolsFor({ handoffAuthorized: false, isToolAllowed: () => true })
        .find((tool) => tool.name === "echo")
      expect(echo).toBeDefined()

      const result = await echo!.execute("connection-diagnostic", {
        value: "http://zap:8080 ConnectionError cookie=session-secret",
      })
      expect(result.details.isError).toBe(false)
    } finally {
      await bridge.close()
      await diagnostics.close()
    }

    try {
      const content = await readFile(path.join(workarea, RUNTIME_DIAGNOSTICS_PATH), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return ""
          throw error
        },
      )
      expect(content).toBe("")
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("keeps routine stdio lifecycle silent without hiding actionable stderr", async () => {
    const observations = [
      {
        message: "[browser] stdio server started",
        component: "browser",
        stage: "startup",
        severity: "info",
        errorClass: "GatewayLifecycle",
        notificationCount: 0,
      },
      {
        message: "[browser] stdio closed",
        component: "browser",
        stage: "shutdown",
        severity: "info",
        errorClass: "GatewayLifecycle",
        notificationCount: 0,
      },
      {
        message: "[browser] agent-browser daemon launching Chrome with an isolated profile",
        component: "browser",
        stage: "startup",
        severity: "info",
        errorClass: "GatewayLifecycle",
        notificationCount: 0,
      },
      {
        message: "[browser] connection refused",
        component: "browser",
        stage: "startup",
        severity: "warning",
        errorClass: "GatewayStderr",
        notificationCount: 1,
      },
      {
        message: "2026-07-30T11:11:18.000Z INFO service=db opening database",
        component: "gateway",
        stage: "startup",
        severity: "info",
        errorClass: "GatewayLog",
        notificationCount: 0,
      },
      {
        message: "ERROR 2026-07-30T11:11:18 service=db migration failed",
        component: "gateway",
        stage: "startup",
        severity: "error",
        errorClass: "GatewayStderr",
        notificationCount: 1,
      },
      {
        message: "WARN phase gateway cleanup recovered after owned-process census",
        component: "gateway",
        stage: "shutdown",
        severity: "info",
        errorClass: "GatewayLifecycle",
        notificationCount: 0,
      },
    ] as const

    for (const observation of observations) {
      const workarea = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-mcp-lifecycle-")))
      const notifications: unknown[] = []
      const diagnostics = new RuntimeDiagnosticRecorder({
        workarea,
        sessionID: "session-1",
        workflow: "pentest",
        phase: "brief",
        attempt: 1,
        onFirst: (summary) => notifications.push(summary),
      })
      const bridge = await connectPiMcp(fixtureServer({ stderrLine: observation.message }), {
        cwd: import.meta.dir,
        diagnostics,
      })
      try {
        expect(bridge.serverName).toBe("pi-mcp-fixture")
      } finally {
        await bridge.close()
        await diagnostics.close()
      }

      try {
        const rows = (await readFile(path.join(workarea, RUNTIME_DIAGNOSTICS_PATH), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          component: observation.component,
          stage: observation.stage,
          severity: observation.severity,
          errorClass: observation.errorClass,
          message: observation.message,
        })
        expect(notifications).toHaveLength(observation.notificationCount)
      } finally {
        await rm(workarea, { recursive: true, force: true })
      }
    }
  })
})
