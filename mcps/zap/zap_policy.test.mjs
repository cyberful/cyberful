// ── ZAP API Request Normalization Contract ─────────────────────────
// Verifies arbitrary catalog operations and destinations survive bridge query
// normalization without acquiring a second host-owned authorization policy.
// → mcps/zap/zap_policy.mjs — owns generic request normalization.
// ────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { apiParameters, operationKey } from "./zap_policy.mjs"

describe("ZAP API bridge normalization", () => {
  test("builds catalog keys for every discovered operation without policy filtering", () => {
    expect(operationKey("spider", "action", "scan")).toBe("spider:action:scan")
    expect(operationKey("core", "action", "shutdown")).toBe("core:action:shutdown")
    expect(operationKey("filexfer", "action", "uploadFile")).toBe("filexfer:action:uploadFile")
  })

  test("normalizes flat parameters without filtering destinations", () => {
    expect(apiParameters({ url: "https://any.example", ids: [1, 2], enabled: true, missing: null })).toEqual({
      url: "https://any.example",
      ids: "1,2",
      enabled: "true",
    })
    expect(apiParameters(["not", "an", "object"])).toEqual({})
    expect(() => apiParameters({ nested: { key: "value" } })).toThrow("must be flat")
  })
})
