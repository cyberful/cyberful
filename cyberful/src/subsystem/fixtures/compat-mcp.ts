// ── Codex MCP Compatibility Fixture ─────────────────────────────
// Implements the minimal protocol-clean JSON-RPC MCP surface used to prove that
// Codex spawns, connects to, lists, and calls a configured gateway before a turn.
// → cyberful/src/subsystem/codex-compat.integration.test.ts — drives and attests this fixture.
// ─────────────────────────────────────────────────────────────────

import { appendFileSync } from "node:fs"

const marker = process.env.MCP_MARKER
const mark = (s: string) => {
  if (!marker) return
  appendFileSync(marker, s + "\n")
}

mark("spawned")

function respond(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
}

let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (d: string) => {
  buf += d
  let nl: number
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg: { id?: unknown; method?: string; params?: { name?: string; protocolVersion?: string } }
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.method === "initialize") {
      mark("mcp-initialize")
      respond(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "compat-mcp", version: "0.0.1" },
      })
    } else if (msg.method === "tools/list") {
      mark("tools-list")
      respond(msg.id, {
        tools: [{ name: "ping", description: "compat probe tool", inputSchema: { type: "object", properties: {} } }],
      })
    } else if (msg.method === "tools/call") {
      mark("tools-call")
      respond(msg.id, { content: [{ type: "text", text: "pong" }] })
    } else if (typeof msg.id !== "undefined" && msg.method) {
      respond(msg.id, {})
    }
  }
})

process.once("SIGINT", () => process.exit(0))
process.once("SIGTERM", () => process.exit(0))
