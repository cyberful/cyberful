// ── Gateway Tool Registry ────────────────────────────────────────
// Keeps every locally advertised MCP definition paired with exactly one typed
// dispatcher and rejects duplicate names during gateway startup.
// ─────────────────────────────────────────────────────────────────

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js"
import type { SessionID } from "@/session/schema"

export type GatewayToolDefinition = {
  readonly name: string
  readonly description?: string
  readonly inputSchema: {
    readonly type: "object"
    readonly properties?: Readonly<Record<string, object>>
    readonly required?: readonly string[]
    readonly [key: string]: unknown
  }
}

export type GatewayToolContext = {
  sessionID: SessionID
  signal: AbortSignal
  actor?: {
    readonly runID: string
    readonly role: "root" | "subagent" | "fallback"
    readonly parentRunID?: string
  }
}

export type GatewayToolHandler = (
  args: Record<string, unknown>,
  context: GatewayToolContext,
) => CallToolResult | Promise<CallToolResult>

type Entry = {
  definition: GatewayToolDefinition
  handler: GatewayToolHandler
}

function publicDefinition(definition: GatewayToolDefinition): Tool {
  const { required, properties, ...schema } = definition.inputSchema
  return {
    name: definition.name,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    inputSchema: {
      ...schema,
      type: "object",
      ...(properties === undefined ? {} : { properties: { ...properties } }),
      ...(required === undefined ? {} : { required: [...required] }),
    },
  }
}

export class GatewayToolRegistry {
  readonly #entries = new Map<string, Entry>()

  register(definition: GatewayToolDefinition, handler: GatewayToolHandler) {
    if (this.#entries.has(definition.name)) throw new Error(`duplicate local gateway tool '${definition.name}'`)
    this.#entries.set(definition.name, { definition, handler })
  }

  definitions() {
    return [...this.#entries.values()].map((entry) => publicDefinition(entry.definition))
  }

  call(name: string, args: Record<string, unknown>, context: GatewayToolContext) {
    return this.#entries.get(name)?.handler(args, context)
  }
}
