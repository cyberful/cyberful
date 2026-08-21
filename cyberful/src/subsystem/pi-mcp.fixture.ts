// ── Pi MCP Bridge Test Gateway ───────────────────────────────────
// Provides a real stdio MCP peer for exercising Pi gateway discovery, calls,
// host elicitation, mixed content, stderr classification, pagination, and
// lifecycle cleanup.
// → cyberful/src/subsystem/pi-mcp.test.ts — owns the observable bridge scenarios.
// ─────────────────────────────────────────────────────────────────

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  approvalElicitationMetadata,
  approvalElicitationSchema,
  hasHumanDecisionMetadata,
  type HumanQuestion,
} from "./human-question"

const objectSchema = {
  type: "object" as const,
  properties: {
    value: { type: "string" },
  },
  required: ["value"],
}

const server = new Server({ name: "cyberful-pi-mcp-test", version: "1.0.0" }, { capabilities: { tools: {} } })
const questions: HumanQuestion[] = [
  {
    header: "Approval",
    question: "Choose whether the fixture should proceed.",
    options: [
      { label: "Proceed", description: "Continue the fixture operation." },
      { label: "Stop", description: "Decline the fixture operation." },
    ],
    custom: false,
  },
]

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

server.setRequestHandler(ListToolsRequestSchema, (request) => {
  if (request.params?.cursor === "second-page")
    return {
      tools: [
        {
          name: "handoff",
          description: "Advance the phase.",
          inputSchema: objectSchema,
        },
      ],
    }

  return {
    tools: [
      {
        name: "echo",
        title: "Gateway Echo",
        description: "Return representative MCP content.",
        inputSchema: objectSchema,
      },
      {
        name: "failure",
        description: "Return an MCP tool error.",
        inputSchema: objectSchema,
      },
      {
        name: "target_cooldown",
        description: "Exercise phase budget suspension.",
        inputSchema: objectSchema,
      },
      {
        name: "test_object",
        description: "Exercise host-owned child ledger recovery.",
        inputSchema: { type: "object" as const, additionalProperties: true, properties: {} },
      },
      {
        name: "filtered",
        description: "Must never enter the Pi catalog.",
        inputSchema: objectSchema,
      },
      {
        name: "question",
        description: "Request one host-owned Cyberful decision.",
        inputSchema: objectSchema,
      },
      {
        name: "agent_browser_close",
        description: "Close an agent-browser profile.",
        inputSchema: { type: "object" as const, additionalProperties: false, properties: {} },
        _meta: { "cyberful.dev/eager": true },
      },
    ],
    nextCursor: "second-page",
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
  const value = typeof request.params.arguments?.value === "string" ? request.params.arguments.value : ""
  if (request.params.name === "failure")
    return {
      isError: true,
      content: [{ type: "text" as const, text: `fixture failure: ${value}` }],
    }
  if (request.params.name === "handoff")
    return {
      content: [{ type: "text" as const, text: `handoff: ${value}` }],
    }
  if (request.params.name === "agent_browser_close")
    return { content: [{ type: "text" as const, text: "browser closed" }] }
  if (request.params.name === "_cyberful_browser_owner_release")
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] }
  if (request.params.name === "target_cooldown")
    return {
      content: [{ type: "text" as const, text: `cooldown: ${value}` }],
    }
  if (request.params.name === "test_object") {
    const fromRunID = request.params.arguments?.fromRunID
    const hostOwned = request.params.arguments?._cyberful_host === true
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            objects:
              hostOwned && typeof fromRunID === "string"
                ? [
                    {
                      id: `object-${fromRunID}`,
                      kind: "temporary_record",
                      label: "fixture record",
                      state: "cleaned",
                      phase: "exploit",
                      evidencePath: "raw/evidence/fixture.json",
                      evidenceExists: false,
                    },
                  ]
                : [],
          }),
        },
      ],
    }
  }
  if (request.params.name === "question") {
    const requestedSchema = approvalElicitationSchema(questions)
    if (value === "invalid-schema") requestedSchema.required = []
    const response = await server.elicitInput(
      {
        mode: "form",
        message: value,
        requestedSchema,
        _meta: approvalElicitationMetadata(questions),
      },
      { signal: context.signal, timeout: 600_000, maxTotalTimeout: 600_000 },
    )
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            action: response.action,
            content: response.content,
            humanDecision: hasHumanDecisionMetadata(response._meta),
          }),
        },
      ],
    }
  }
  if (request.params.name !== "echo")
    return {
      isError: true,
      content: [{ type: "text" as const, text: "unknown fixture tool" }],
    }
  if (value === "actor-meta") {
    const actor = record(request.params._meta)?.["io.cyberful/tool-actor"]
    return {
      content: [{ type: "text" as const, text: JSON.stringify(actor) }],
    }
  }
  return {
    content: [
      { type: "text" as const, text: `echo: ${value}` },
      { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" },
      { type: "audio" as const, data: "YXVkaW8=", mimeType: "audio/wav" },
      {
        type: "resource" as const,
        resource: { uri: "fixture://text", text: "resource text", mimeType: "text/plain" },
      },
      {
        type: "resource" as const,
        resource: { uri: "fixture://blob", blob: "YmxvYg==", mimeType: "application/octet-stream" },
      },
      {
        type: "resource_link" as const,
        uri: "fixture://linked",
        name: "linked fixture",
        mimeType: "text/plain",
      },
    ],
    structuredContent: { status: "complete" },
  }
})

const stderrLine = process.env.CYBERFUL_TEST_STDERR_LINE
if (stderrLine) process.stderr.write(`${stderrLine}\n`)
const startupDelayText = process.env.CYBERFUL_TEST_STARTUP_DELAY_MS
if (startupDelayText !== undefined) {
  if (!/^(?:0|[1-9]\d{0,3})$/u.test(startupDelayText))
    throw new Error("CYBERFUL_TEST_STARTUP_DELAY_MS must be an integer from 0 through 9999")
  await Bun.sleep(Number(startupDelayText))
}
await server.connect(new StdioServerTransport())
