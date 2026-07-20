// ── Installed Codex Compatibility Gate ──────────────────────────
// Exercises real strict configuration, app-server JSON-RPC, and gateway MCP
// discovery before authentication so incompatible installed CLIs fail the build.
// → cyberful/src/subsystem/provider.ts — supplies the production argument builders under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { codex } from "./provider"
import type { SubsystemRunSpec } from "./provider"
import { errorMessage } from "@/util/error"
import { run as runProcess } from "@/util/process"

const FIXTURE_MCP = path.join(import.meta.dir, "fixtures", "compat-mcp.ts")
const MAX_CODEX_OUTPUT_BYTES = 2 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function run(command: string[]): Promise<{ code: number | null; out: string }> {
  try {
    const result = await runProcess(command, {
      abort: AbortSignal.timeout(30_000),
      timeout: 1_000,
      maxOutputBytes: MAX_CODEX_OUTPUT_BYTES,
      nothrow: true,
    })
    return { code: result.code, out: result.stdout.toString("utf8") + result.stderr.toString("utf8") }
  } catch (error) {
    return { code: null, out: errorMessage(error) }
  }
}

async function boundedText(stream: ReadableStream<Uint8Array>, label: string) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks, size).toString("utf8")
      size += value.byteLength
      if (size > MAX_CODEX_OUTPUT_BYTES) {
        const failure = new Error(`${label} exceeded ${MAX_CODEX_OUTPUT_BYTES} bytes`)
        try {
          await reader.cancel(failure)
        } catch (error) {
          throw new AggregateError([failure, error], `${label} overflow cleanup failed`)
        }
        throw failure
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

async function beforeTimeout<T>(operation: Promise<T>, timeoutMs: number, failure: Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(failure), timeoutMs)
  })
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

type ResponsesModelProbe = {
  baseURL: string
  requests: Record<string, unknown>[]
  stop(): Promise<void>
}

type ModelToolReference = { name: string; namespace?: string }

function modelTool(body: Record<string, unknown>, target: string): ModelToolReference | undefined {
  const tools = Array.isArray(body.tools) ? body.tools : []
  for (const candidate of tools) {
    if (!isRecord(candidate) || typeof candidate.name !== "string") continue
    if (candidate.name.includes(target)) return { name: candidate.name }
    if (!Array.isArray(candidate.tools)) continue
    const child = candidate.tools.find(
      (value) => isRecord(value) && typeof value.name === "string" && value.name.includes(target),
    )
    if (isRecord(child) && typeof child.name === "string") return { namespace: candidate.name, name: child.name }
  }
  return undefined
}

function latestUserText(body: Record<string, unknown>): string {
  const input = Array.isArray(body.input) ? body.input : []
  for (const item of input.toReversed()) {
    if (!isRecord(item) || item.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) continue
    const text = item.content
      .filter((part) => isRecord(part) && part.type === "input_text" && typeof part.text === "string")
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("\n")
    if (text) return text
  }
  return ""
}

function hasToolOutput(body: Record<string, unknown>, callID: string): boolean {
  return (
    Array.isArray(body.input) &&
    body.input.some(
      (item) =>
        isRecord(item) &&
        item.call_id === callID &&
        typeof item.type === "string" &&
        item.type.endsWith("_call_output"),
    )
  )
}

function responsesSse(events: Record<string, unknown>[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
}

function modelResponse(id: string, output?: Record<string, unknown>): Response {
  const events: Record<string, unknown>[] = [
    { type: "response.created", response: { id } },
    ...(output ? [{ type: "response.output_item.done", item: output }] : []),
    {
      type: "response.completed",
      response: {
        id,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ]
  return new Response(responsesSse(events), { headers: { "content-type": "text/event-stream" } })
}

// ── A Loopback Model Keeps Timeout Proofs Hermetic ───────────────
// The timing regression must run inside a genuine model turn because Codex
// intentionally declines MCP elicitations invoked by a detached direct tool
// call. This Responses-compatible loopback selects only the named fixture tool
// from the tool inventory supplied by Codex, then finishes the turn after its
// output arrives. No provider credentials or external network are involved.
// ───────────────────────────────────────────────────────────────
function startResponsesModelProbe(): ResponsesModelProbe {
  const requests: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname.endsWith("/models"))
        return Response.json({ object: "list", data: [] })
      if (request.method !== "POST" || !url.pathname.endsWith("/responses"))
        return Response.json({ error: "not found" }, { status: 404 })
      const decoded: unknown = await request.json()
      if (!isRecord(decoded)) return Response.json({ error: "invalid body" }, { status: 400 })
      requests.push(decoded)
      const prompt = latestUserText(decoded).toLowerCase()
      const target = prompt.includes("eliciting") ? "eliciting" : prompt.includes("slow") ? "slow" : undefined
      if (!target) return modelResponse(`resp-${requests.length}`, assistantMessage("fixture turn complete"))
      const callID = `call-${target}`
      if (hasToolOutput(decoded, callID))
        return modelResponse(`resp-${requests.length}`, assistantMessage(`${target} tool observed`))
      const tool = modelTool(decoded, target)
      if (!tool) return Response.json({ error: `missing ${target} tool` }, { status: 500 })
      return modelResponse(`resp-${requests.length}`, {
        type: "function_call",
        call_id: callID,
        name: tool.name,
        arguments: "{}",
        ...(tool.namespace ? { namespace: tool.namespace } : {}),
      })
    },
  })
  return {
    baseURL: `http://${server.hostname}:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  }
}

function assistantMessage(text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "assistant",
    id: `message-${crypto.randomUUID()}`,
    content: [{ type: "output_text", text }],
  }
}

function loopbackModelArgs(baseURL: string): string[] {
  return [
    "-c",
    'model="fixture-model"',
    "-c",
    'model_provider="fixture"',
    "-c",
    `model_providers.fixture={name="Fixture",base_url=${JSON.stringify(baseURL)},wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
  ]
}

// ── The Compatibility Probe Owns The Complete RPC Lifetime ──────
// The gate starts Codex without a model turn, then coordinates every request
// write with its bounded response deadline and validates JSON before use. One
// reader owns stdout while stderr has an independent memory ceiling. Success,
// protocol failure, timeout, and assertion failure all terminate and reap the
// child, escalate a stuck shutdown, and settle both output observers.
// ─────────────────────────────────────────────────────────────────
interface CompatibilityProbeOptions {
  elicitationDelayMs?: number
  exerciseElicitation?: boolean
  exerciseSlowTool?: boolean
  turnTimeoutMs?: number
}

interface CompatibilityProbeResult {
  threadId: string
  serverRequests: string[]
  elicitation?: { durationMs: number; turn: Record<string, unknown> }
  slowTool?: { durationMs: number; turn: Record<string, unknown> }
}

async function driveAppServer(
  args: string[],
  extraEnv: Record<string, string>,
  cwd: string,
  options: CompatibilityProbeOptions = {},
): Promise<CompatibilityProbeResult> {
  const proc = Bun.spawn(["codex", ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env: { ...process.env, ...extraEnv },
  })
  const stderr = boundedText(proc.stderr, "Codex stderr")
  const enc = new TextEncoder()
  const send = (value: unknown) => {
    proc.stdin.write(enc.encode(JSON.stringify(value) + "\n"))
    return Promise.resolve(proc.stdin.flush())
  }
  const pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const observedServerRequests: string[] = []
  let activeTurnCompletion: ReturnType<typeof Promise.withResolvers<Record<string, unknown>>> | undefined

  const responseReader = (async () => {
    const dec = new TextDecoder()
    let buf = ""
    const reader = proc.stdout.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      if (Buffer.byteLength(buf) > MAX_CODEX_OUTPUT_BYTES)
        throw new Error(`Codex JSON-RPC frame exceeded ${MAX_CODEX_OUTPUT_BYTES} bytes`)
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let decoded: unknown
        try {
          decoded = JSON.parse(line)
        } catch (error) {
          throw new Error("Codex app-server emitted malformed JSON", { cause: error })
        }
        if (!isRecord(decoded)) continue
        const msg = decoded
        if (typeof msg.method === "string" && msg.id !== undefined)
          observedServerRequests.push(`${msg.method}:${typeof msg.id}`)
        if (
          (typeof msg.id === "string" || typeof msg.id === "number") &&
          msg.method === "mcpServer/elicitation/request"
        ) {
          await Bun.sleep(options.elicitationDelayMs ?? 0)
          await send({
            id: msg.id,
            result: { action: "accept", content: { answer: "continue" }, _meta: null },
          })
          continue
        }
        if (msg.method === "turn/completed" && isRecord(msg.params) && isRecord(msg.params.turn)) {
          activeTurnCompletion?.resolve(msg.params.turn)
          activeTurnCompletion = undefined
        }
        if (typeof msg.id === "number" && !msg.method) {
          const request = pending.get(msg.id)
          if (!request) continue
          clearTimeout(request.timer)
          pending.delete(msg.id)
          request.resolve(msg)
        }
      }
    }
  })().then(
    () => undefined,
    (error) => {
      const failure = error instanceof Error ? error : new Error(String(error))
      for (const request of pending.values()) {
        clearTimeout(request.timer)
        request.reject(failure)
      }
      pending.clear()
      return failure
    },
  )
  const exited = proc.exited.then((code) => {
    for (const [id, request] of pending) {
      clearTimeout(request.timer)
      request.reject(new Error(`codex app-server exited with code ${code} while waiting for request ${id}`))
    }
    pending.clear()
    return code
  })
  let requestID = 0
  const request = async (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const id = ++requestID
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${method}`))
      }, 30000)
      pending.set(id, { resolve, reject, timer })
    })
    try {
      const [, message] = await Promise.all([send({ id, method, params }), response])
      return message
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      const registered = pending.get(id)
      if (registered) {
        clearTimeout(registered.timer)
        pending.delete(id)
        registered.reject(failure)
      }
      throw failure
    }
  }

  let interaction: { status: "success"; value: CompatibilityProbeResult } | { status: "failure"; error: unknown }
  try {
    const init = await request("initialize", {
      clientInfo: { name: "cyberful-compat", title: "cyberful compat", version: "0.0.1" },
      capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: false },
    })
    if (init.error) throw new Error(`initialize error: ${JSON.stringify(init.error)}`)
    await send({ method: "initialized" })
    const thread = await request("thread/start", {
      model: null,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: {
        granular: {
          sandbox_approval: false,
          rules: false,
          skill_approval: false,
          request_permissions: false,
          mcp_elicitations: true,
        },
      },
      sandbox: "read-only",
      ephemeral: true,
    })
    if (thread.error) throw new Error(`thread/start error: ${JSON.stringify(thread.error)}`)
    const threadResult = thread.result
    const threadInfo = isRecord(threadResult) ? threadResult.thread : undefined
    const threadId = isRecord(threadInfo) ? threadInfo.id : undefined
    if (typeof threadId !== "string") throw new Error("thread/start returned no thread id")
    const marker = extraEnv.MCP_MARKER
    if (marker) {
      const deadline = Date.now() + 30000
      while (!(await readFile(marker, "utf8").catch(() => "")).includes("tools-list")) {
        if (Date.now() >= deadline) throw new Error("timeout waiting for configured MCP tools/list")
        await Bun.sleep(100)
      }
    }
    const value: CompatibilityProbeResult = { threadId, serverRequests: observedServerRequests }
    if (options.exerciseElicitation || options.exerciseSlowTool) {
      const runTurn = async (prompt: string) => {
        activeTurnCompletion = Promise.withResolvers<Record<string, unknown>>()
        const completion = activeTurnCompletion.promise
        const turn = await request("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt }],
          model: "fixture-model",
        })
        if (turn.error) throw new Error(`turn/start error: ${JSON.stringify(turn.error)}`)
        return beforeTimeout(
          completion,
          options.turnTimeoutMs ?? 15_000,
          new Error(`timeout waiting for ${prompt} turn`),
        )
      }
      if (options.exerciseElicitation) {
        const elicitationStarted = Date.now()
        const elicitation = await runTurn("Call the eliciting compatibility tool now.")
        value.elicitation = { durationMs: Date.now() - elicitationStarted, turn: elicitation }
      }
      if (options.exerciseSlowTool) {
        const slowStarted = Date.now()
        const slowTool = await runTurn("Call the slow compatibility tool now.")
        value.slowTool = { durationMs: Date.now() - slowStarted, turn: slowTool }
      }
    }
    interaction = { status: "success", value }
  } catch (error) {
    interaction = { status: "failure", error }
  }

  proc.kill()
  const force = setTimeout(() => proc.kill("SIGKILL"), 1_000)
  const [exitResult, readerResult, stderrResult] = await Promise.allSettled([exited, responseReader, stderr]).finally(
    () => clearTimeout(force),
  )
  const observationFailures: unknown[] = []
  if (exitResult.status === "rejected") observationFailures.push(exitResult.reason)
  if (readerResult.status === "rejected") observationFailures.push(readerResult.reason)
  if (readerResult.status === "fulfilled" && readerResult.value) observationFailures.push(readerResult.value)
  if (stderrResult.status === "rejected") observationFailures.push(stderrResult.reason)
  const stderrText = stderrResult.status === "fulfilled" ? stderrResult.value : ""
  const detail = stderrText.trim()
  if (interaction.status === "failure") {
    const message = interaction.error instanceof Error ? interaction.error.message : String(interaction.error)
    const cause =
      observationFailures.length > 0
        ? new AggregateError([interaction.error, ...observationFailures], "Codex interaction and cleanup failed")
        : interaction.error
    throw new Error(detail ? `${message}\nCodex stderr:\n${detail}` : message, { cause })
  }
  if (observationFailures.length > 0) {
    const failure =
      observationFailures.length === 1
        ? observationFailures[0]
        : new AggregateError(observationFailures, "Codex process observation failed")
    const message = errorMessage(failure)
    throw new Error(detail ? `${message}\nCodex stderr:\n${detail}` : message, {
      cause: failure,
    })
  }
  return interaction.value
}

describe("codex", () => {
  test("exec and app-server subcommands exist", async () => {
    expect((await run(["codex", "exec", "--help"])).code).toBe(0)
    expect((await run(["codex", "app-server", "--help"])).code).toBe(0)
  })

  test("app-server exposes the phase activity and steering contracts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cyberful-codex-protocol-"))
    try {
      expect((await run(["codex", "app-server", "generate-ts", "--experimental", "--out", dir])).code).toBe(0)
      expect(await readFile(path.join(dir, "v2", "ThreadTokenUsage.ts"), "utf8")).toContain(
        "total: TokenUsageBreakdown",
      )
      expect(await readFile(path.join(dir, "v2", "TokenUsageBreakdown.ts"), "utf8")).toContain("outputTokens: number")
      const steerParams = await readFile(path.join(dir, "v2", "TurnSteerParams.ts"), "utf8")
      expect(steerParams).toContain("threadId: string")
      expect(steerParams).toContain("expectedTurnId: string")
      expect(steerParams).toContain("input: Array<UserInput>")
      expect(await readFile(path.join(dir, "v2", "TurnSteerResponse.ts"), "utf8")).toContain("turnId: string")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("codex login exposes a `status` subcommand (used by the runtime preflight)", async () => {
    const { out } = await run(["codex", "login", "--help"])
    expect(out).toContain("status")
  })

  test("--strict-config rejects an unknown key (negative control — proves the check is live)", async () => {
    const { out } = await run([
      "codex",
      "app-server",
      "--stdio",
      "--strict-config",
      "-c",
      "cyberful_bogus_unknown_key=1",
    ])
    expect(out).toContain("unknown configuration field")
  })

  test("--strict-config accepts cyberful's phase config keys and Codex connects to a configured MCP", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cyberful-codex-compat-"))
    const marker = path.join(dir, "mcp-marker.txt")
    const spec: SubsystemRunSpec = {
      cwd: dir,
      permission: { kind: "readonly" },
      mcpServer: { name: "probe", command: "bun", args: [FIXTURE_MCP], env: { MCP_MARKER: marker } },
    }
    const { args, extraEnv } = codex.buildAppServerArgs(spec)
    try {
      const result = await driveAppServer(args, extraEnv, dir)
      expect(result.threadId).toBeTruthy()
      const recorded = await readFile(marker, "utf8").catch(() => "")
      // The exact integration path a phase's expert-gateway uses — spawn, MCP handshake, tool discovery.
      expect(recorded).toContain("spawned")
      expect(recorded).toContain("mcp-initialize")
      expect(recorded).toContain("tools-list")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)

  test("native elicitation pauses MCP active time while an ordinary slow tool expires", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cyberful-codex-elicitation-timeout-"))
    const marker = path.join(dir, "mcp-marker.txt")
    const model = startResponsesModelProbe()
    const spec: SubsystemRunSpec = {
      cwd: dir,
      permission: { kind: "readonly" },
      mcpServer: {
        name: "probe",
        command: "bun",
        args: [FIXTURE_MCP],
        env: { MCP_MARKER: marker, MCP_OPERATION_DELAY_MS: "1250" },
      },
    }
    const built = codex.buildAppServerArgs(spec)
    const args = [
      ...built.args.map((argument) => argument.replace("tool_timeout_sec=600", "tool_timeout_sec=1")),
      ...loopbackModelArgs(model.baseURL),
    ]
    try {
      const result = await driveAppServer(args, built.extraEnv, dir, {
        elicitationDelayMs: 1_250,
        exerciseElicitation: true,
        exerciseSlowTool: true,
      })
      const recorded = await readFile(marker, "utf8").catch(() => "")
      expect(recorded).toContain('"elicitation"')
      expect(result.serverRequests).toContain("mcpServer/elicitation/request:number")
      expect(result.elicitation?.turn.status).toBe("completed")
      expect(result.elicitation?.durationMs).toBeGreaterThanOrEqual(1_200)
      expect(result.slowTool?.durationMs).toBeGreaterThanOrEqual(900)
      expect(result.slowTool?.turn.status).toBe("completed")
      expect(JSON.stringify(model.requests)).toContain("elicitation-accept")
      expect(JSON.stringify(model.requests).toLowerCase()).toContain("timed out")
      expect(recorded).toContain("elicitation-accept")
    } finally {
      await model.stop()
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)

  const historicalApprovalTest = process.env.CYBERFUL_APPROVAL_LONG_TEST === "1" ? test : test.skip
  historicalApprovalTest(
    "native elicitation accepts the historical response after 628 seconds",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "cyberful-codex-elicitation-628s-"))
      const marker = path.join(dir, "mcp-marker.txt")
      const model = startResponsesModelProbe()
      const spec: SubsystemRunSpec = {
        cwd: dir,
        permission: { kind: "readonly" },
        mcpServer: { name: "probe", command: "bun", args: [FIXTURE_MCP], env: { MCP_MARKER: marker } },
      }
      const built = codex.buildAppServerArgs(spec)
      try {
        const result = await driveAppServer([...built.args, ...loopbackModelArgs(model.baseURL)], built.extraEnv, dir, {
          elicitationDelayMs: 628_000,
          exerciseElicitation: true,
          turnTimeoutMs: 645_000,
        })
        expect(result.elicitation?.turn.status).toBe("completed")
        expect(result.elicitation?.durationMs).toBeGreaterThanOrEqual(628_000)
        expect(JSON.stringify(model.requests)).toContain("elicitation-accept")
        expect(await readFile(marker, "utf8")).toContain("elicitation-accept")
      } finally {
        await model.stop()
        await rm(dir, { recursive: true, force: true })
      }
    },
    660000,
  )
})
