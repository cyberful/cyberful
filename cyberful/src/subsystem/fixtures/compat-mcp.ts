// ── Codex MCP Compatibility Fixture ─────────────────────────────
// Implements the minimal protocol-clean JSON-RPC MCP surface used to prove that
// Codex spawns, connects to, lists, and calls a configured gateway before a turn.
// → cyberful/src/subsystem/codex-compat.integration.test.ts — drives and attests this fixture.
// ─────────────────────────────────────────────────────────────────

import { appendFileSync } from "node:fs"

const marker = process.env.MCP_MARKER
const useCyberfulApproval = process.env.MCP_CYBERFUL_APPROVAL === "1"
const mark = (s: string) => {
  if (!marker) return
  appendFileSync(marker, s + "\n")
}

mark("spawned")

function respond(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
}

function elicitationParams(): Record<string, unknown> {
  if (!useCyberfulApproval)
    return {
      mode: "form",
      message: "Continue the compatibility probe?",
      requestedSchema: {
        type: "object",
        properties: { answer: { type: "string", enum: ["continue"] } },
        required: ["answer"],
      },
    }

  const question = {
    question: "Continue the compatibility probe?",
    header: "Compatibility",
    options: [{ label: "Proceed", description: "Continue the compatibility probe." }],
    multiple: false,
    custom: false,
  }
  return {
    mode: "form",
    message: question.question,
    requestedSchema: {
      type: "object",
      properties: {
        q0: {
          type: "string",
          title: question.header,
          description: `${question.question} Return a JSON array of selected labels or allowed custom values.`,
          minLength: 2,
          maxLength: 161_024,
        },
      },
      required: ["q0"],
    },
    _meta: {
      "cyberful.dev/approval": {
        version: 1,
        kind: "approval",
        questions: [question],
      },
    },
  }
}

let pendingElicitationCall: unknown
let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (d: string) => {
  buf += d
  let nl: number
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg: {
      id?: unknown
      method?: string
      params?: { name?: string; protocolVersion?: string; capabilities?: unknown }
      result?: { action?: string }
    }
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.method === "initialize") {
      mark("mcp-initialize")
      mark(`mcp-client-capabilities:${JSON.stringify(msg.params?.capabilities ?? null)}`)
      respond(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "compat-mcp", version: "0.0.1" },
      })
    } else if (msg.method === "tools/list") {
      mark("tools-list")
      respond(msg.id, {
        tools: [
          { name: "ping", description: "compat probe tool", inputSchema: { type: "object", properties: {} } },
          {
            name: "eliciting",
            description: "waits on one standard form elicitation",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "slow",
            description: "uses active tool time without elicitation",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      })
    } else if (msg.method === "tools/call") {
      mark("tools-call")
      if (msg.params?.name === "eliciting") {
        pendingElicitationCall = msg.id
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "elicitation-1",
            method: "elicitation/create",
            params: elicitationParams(),
          }) + "\n",
        )
      } else if (msg.params?.name === "slow") {
        const delay = Number(process.env.MCP_OPERATION_DELAY_MS ?? "0")
        setTimeout(
          () => respond(msg.id, { content: [{ type: "text", text: "slow-complete" }] }),
          Number.isFinite(delay) ? Math.max(0, delay) : 0,
        )
      } else {
        respond(msg.id, { content: [{ type: "text", text: "pong" }] })
      }
    } else if (msg.id === "elicitation-1" && msg.result?.action) {
      mark(`elicitation-${msg.result.action}`)
      const call = pendingElicitationCall
      pendingElicitationCall = undefined
      respond(call, { content: [{ type: "text", text: `elicitation-${msg.result.action}` }] })
    } else if (typeof msg.id !== "undefined" && msg.method) {
      respond(msg.id, {})
    }
  }
})

process.once("SIGINT", () => process.exit(0))
process.once("SIGTERM", () => process.exit(0))
