// ── ZAP OAST Capability Contract Tests ────────────────────────────────
// Verifies that the bridge advertises only installed OAST API operations,
// rejects guessed service subcomponents and lifecycle methods before transport,
// and distinguishes a successful empty response from an execution error.
// → mcps/zap/zap_oast.mjs — owns the catalog-derived contract.
// ───────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { completedOastCall, oastCapabilities, oastToolDefinition, resolveOastOperation } from "./zap_oast.mjs"

const catalog = new Map([
  ["oast:view:getServices", { component: "oast", type: "view", operation: "getServices" }],
  ["oast:view:getInteractshOptions", { component: "oast", type: "view", operation: "getInteractshOptions" }],
  ["oast:action:setInteractshOptions", { component: "oast", type: "action", operation: "setInteractshOptions" }],
  ["script:action:load", { component: "script", type: "action", operation: "load" }],
])

describe("ZAP OAST adapter", () => {
  test("derives its visible operations and lifecycle limits from the installed catalog", () => {
    const capabilities = oastCapabilities(catalog)
    expect(capabilities.status).toBe("available")
    expect(capabilities.operations).toEqual([
      { component: "oast", type: "action", operation: "setInteractshOptions" },
      { component: "oast", type: "view", operation: "getInteractshOptions" },
      { component: "oast", type: "view", operation: "getServices" },
    ])
    expect(capabilities.lifecycle).toEqual({
      registration: "not_exposed_by_http_api",
      payload_generation: "not_exposed_by_http_api",
      polling: "not_exposed_by_http_api",
      interaction_history: "not_exposed_by_http_api",
    })
    expect(oastToolDefinition(catalog).inputSchema.properties.operation.enum).toEqual([
      "setInteractshOptions",
      "getInteractshOptions",
      "getServices",
    ])
  })

  test("resolves real operations and rejects guessed subcomponents or lifecycle calls", () => {
    expect(resolveOastOperation(catalog, {})).toBeUndefined()
    expect(resolveOastOperation(catalog, { component: "oast", type: "view", operation: "getServices" })).toEqual({
      component: "oast",
      type: "view",
      operation: "getServices",
    })
    expect(() =>
      resolveOastOperation(catalog, { component: "interactsh", type: "view", operation: "getNewPayload" }),
    ).toThrow("not exposed")
    expect(() => resolveOastOperation(catalog, { type: "action", operation: "poll" })).toThrow("available operations")
  })

  test("labels a successful empty API result without turning it into an error", () => {
    expect(completedOastCall({ component: "oast", type: "view", operation: "getServices" }, {})).toEqual({
      status: "completed",
      result_state: "empty",
      operation: { component: "oast", type: "view", operation: "getServices" },
      result: {},
    })
  })
})
