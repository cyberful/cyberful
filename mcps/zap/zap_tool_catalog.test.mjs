// ── ZAP Bridge Catalog Contract ──────────────────────────────────
// Locks bridge-owned tool names and strict top-level schemas independently from
//   a running ZAP daemon or the official upstream MCP catalog.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { ZAP_BRIDGE_TOOLS } from "./zap_tool_catalog.mjs"

describe("ZAP bridge tool catalog", () => {
  test("keeps every bridge tool unique, namespaced, and schema-backed", () => {
    const names = ZAP_BRIDGE_TOOLS.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual([
      "zap_api_catalog",
      "zap_api_call",
      "zap_http_request",
      "zap_generate_workarea_report",
      "zap_history_search",
      "zap_history_get",
      "zap_history_replay",
      "zap_websocket_history",
      "zap_context_auth",
      "zap_prompt_get",
    ])
    for (const tool of ZAP_BRIDGE_TOOLS) {
      expect(tool.inputSchema.type).toBe("object")
      expect(tool.inputSchema.additionalProperties).toBe(false)
    }
    const report = ZAP_BRIDGE_TOOLS.find((tool) => tool.name === "zap_generate_workarea_report")
    expect(report?.inputSchema.properties.sites).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
    })
  })
})
