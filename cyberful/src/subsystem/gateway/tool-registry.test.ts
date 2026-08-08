// ── Gateway Tool Registry Contract ──────────────────────────────
// Proves that advertised local tools have one dispatcher and that readonly
//   schemas are normalized without changing their public shape.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { SessionID } from "@/session/schema"
import { GatewayToolRegistry } from "./tool-registry"

const definition = {
  name: "probe",
  description: "Probe the registry.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { value: { type: "string" } },
    required: ["value"],
  },
} as const

describe("gateway tool registry", () => {
  test("pairs definitions with dispatchers and rejects duplicate names", async () => {
    const registry = new GatewayToolRegistry()
    registry.register(definition, (args, context) => ({
      content: [{ type: "text", text: `${context.sessionID}:${String(args.value)}` }],
    }))

    expect(registry.definitions()).toEqual([
      {
        name: "probe",
        description: "Probe the registry.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    ])
    expect(
      await registry.call("probe", { value: "ok" }, {
        sessionID: SessionID.make("ses_registry"),
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      content: [{ type: "text", text: "ses_registry:ok" }],
    })
    expect(
      registry.call("missing", {}, {
        sessionID: SessionID.make("ses_registry"),
        signal: new AbortController().signal,
      }),
    ).toBeUndefined()
    expect(() => registry.register(definition, () => ({ content: [] }))).toThrow("duplicate local gateway tool")
  })
})
