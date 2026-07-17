// ── ZAP API Policy Contract ─────────────────────────────────────────
// Verifies routine catalog calls remain available while host lifecycle,
// security weakening, file transfer, and unsafe raw operations stay blocked.
// → mcps/zap/zap_policy.mjs — owns generic operation authorization.
// ────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import {
  apiParameters,
  assertAllowedOperation,
  assertScopedZapTool,
  operationKey,
  parseZapAllowedOrigins,
} from "./zap_policy.mjs"

describe("ZAP API bridge policy", () => {
  test("builds catalog keys from structured fields", () => {
    expect(operationKey("spider", "action", "scan")).toBe("spider:action:scan")
    expect(assertAllowedOperation("spider", "action", "scan")).toBe("spider:action:scan")
  })

  test("blocks host lifecycle, authentication weakening, file transfer, and listener expansion", () => {
    expect(() => assertAllowedOperation("core", "action", "shutdown")).toThrow("host-owned")
    expect(() => assertAllowedOperation("core", "action", "sendRequest")).toThrow("host-owned")
    expect(() => assertAllowedOperation("core", "view", "messages")).toThrow("host-owned")
    expect(() => assertAllowedOperation("core", "view", "message")).toThrow("host-owned")
    expect(() => assertAllowedOperation("core", "action", "setOptionApiKey")).toThrow("host-owned")
    expect(() => assertAllowedOperation("mcp", "action", "setOptionSecurityKeyEnabled")).toThrow("host-owned")
    expect(() => assertAllowedOperation("mcp", "action", "setOptionAddress")).toThrow("host-owned")
    expect(() => assertAllowedOperation("filexfer", "action", "uploadFile")).toThrow("host-owned")
    expect(() => assertAllowedOperation("network", "action", "addLocalServer")).toThrow("host-owned")
    expect(() => assertAllowedOperation("network", "action", "updateAlias")).toThrow("host-owned")
    expect(() => assertAllowedOperation("core", "action", "setOptionProxyIp")).toThrow("host-owned")
    expect(() => assertAllowedOperation("core", "delete", "message")).toThrow("unsupported")
  })

  test("normalizes parameters without admitting nested transport objects", () => {
    expect(apiParameters({ url: "https://target.example", ids: [1, 2], enabled: true, missing: null })).toEqual({
      url: "https://target.example",
      ids: "1,2",
      enabled: "true",
    })
    expect(apiParameters(["not", "an", "object"])).toEqual({})
    expect(() => apiParameters({ nested: { key: "value" } })).toThrow("must be flat")
  })

  test("keeps model-selected active tools when they name an authorized target", () => {
    const origins = parseZapAllowedOrigins('["https://target.example","https://auth.example"]')
    expect(() =>
      assertScopedZapTool("zap_active_scan", { url: "https://target.example/api" }, origins, true),
    ).not.toThrow()
    expect(() =>
      assertScopedZapTool(
        "zap_api_call",
        { component: "spider", type: "action", operation: "scan", parameters: { url: "https://target.example" } },
        origins,
      ),
    ).not.toThrow()
    expect(() => assertScopedZapTool("zap_scan_status", { scan_id: "1" }, origins, true)).not.toThrow()
    expect(() =>
      assertScopedZapTool(
        "zap_context_auth",
        { component: "context", type: "action", operation: "includeInContext", parameters: {} },
        origins,
      ),
    ).not.toThrow()
  })

  test("blocks only unscoped egress, foreign origins, and automatic redirects", () => {
    const origins = parseZapAllowedOrigins('["https://target.example"]')
    expect(() => assertScopedZapTool("zap_active_scan", {}, origins, true)).toThrow("explicit")
    expect(() =>
      assertScopedZapTool("zap_active_scan", { url: "https://foreign.example" }, origins, true),
    ).toThrow("outside")
    expect(() =>
      assertScopedZapTool(
        "zap_api_call",
        { component: "spider", type: "action", operation: "scan", parameters: {} },
        origins,
      ),
    ).toThrow("explicit")
    expect(() =>
      assertScopedZapTool(
        "zap_http_request",
        { target_url: "https://target.example", request: "GET / HTTP/1.1", follow_redirects: true },
        origins,
      ),
    ).toThrow("redirects")
    expect(() =>
      assertScopedZapTool(
        "zap_oast",
        { component: "oast", type: "action", operation: "start" },
        origins,
      ),
    ).toThrow("service URL")
  })
})
