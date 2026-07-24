// ── Browser Tool Registry Contract ───────────────────────────────
// Proves discovery cannot drift from dispatch and duplicate names fail before
//   any browser process starts.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { BrowserToolRegistry } from "./browser_tool_registry.mjs"

describe("browser tool registry", () => {
  test("pairs definitions with one handler and rejects duplicates", () => {
    const registry = new BrowserToolRegistry()
    const handler = () => ({ content: [] })
    registry.register({
      name: "browser_probe",
      description: "Probe.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      handler,
    })

    expect(registry.find("browser_probe")?.handler).toBe(handler)
    expect(registry.definitions()).toEqual([
      {
        name: "browser_probe",
        description: "Probe.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
      },
    ])
    expect(() =>
      registry.register({
        name: "browser_probe",
        description: "Duplicate.",
        inputSchema: { type: "object" },
        handler,
      }),
    ).toThrow("duplicate browser tool")
  })
})
