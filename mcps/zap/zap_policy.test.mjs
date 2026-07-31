// ── ZAP API Request Normalization Contract ─────────────────────────
// Verifies arbitrary catalog operations and destinations survive bridge query
// normalization without acquiring a second host-owned authorization policy.
// → mcps/zap/zap_policy.mjs — owns generic request normalization.
// ────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import {
  apiOperationContract,
  apiParameters,
  operationKey,
  validatedApiParameters,
  ZapApiContractError,
  zapApiResponseError,
} from "./zap_policy.mjs"

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

  test("validates the script operations that previously reached ZAP malformed", () => {
    expect(apiOperationContract("script:action:load")).toEqual({
      required: ["scriptName", "scriptType", "scriptEngine", "fileName"],
      optional: ["scriptDescription", "charset"],
    })
    expect(() =>
      validatedApiParameters("script:action:load", {
        scriptName: "probe",
        scriptType: "standalone",
      }),
    ).toThrow("scriptEngine, fileName")
    expect(
      validatedApiParameters("script:view:globalCustomVar", { varKey: "probe.result" }),
    ).toEqual({ varKey: "probe.result" })
  })

  test("classifies missing parameters and absent resources without raw response bodies", () => {
    const missing = zapApiResponseError(
      "script:action:load",
      400,
      "missing required parameter scriptEngine",
    )
    expect(missing).toMatchObject({ code: "ZAP_PARAMETER_MISSING", path: "parameters" })
    const absent = zapApiResponseError(
      "script:view:globalCustomVar",
      400,
      "does_not_exist",
    )
    expect(absent).toMatchObject({ code: "ZAP_RESOURCE_NOT_FOUND" })
    expect(absent).toBeInstanceOf(ZapApiContractError)
  })
})
