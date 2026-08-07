// ── Host-Enforced Engagement Policy Tests ───────────────────────
// Verifies non-secret policy persistence and validation before ZAP enforcement.
// → cyberful/src/subsystem/gateway/engagement-policy.ts — owns the policy.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  applyEngagementRateLimit,
  EngagementPolicyStore,
  readEngagementPolicy,
  ZapRateLimitInstallError,
} from "./engagement-policy"

describe("engagement policy", () => {
  test("persists one aggregate HTTP limit without secrets", async () => {
    const workarea = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-policy-")))
    try {
      const store = new EngagementPolicyStore(workarea)
      const candidate = store.prepare({
        action: "set",
        profiles: [{ profile: 2, readiness: "READY", scope: "IN_SCOPE", origin: "https://app.example.test/home" }],
        authorized_http_hosts: ["app.example.test", "*.api.example.test"],
        global_http_rps: 4,
      })
      await store.commit(candidate)
      expect(await readEngagementPolicy(workarea)).toMatchObject({
        profiles: [{ profile: 2, origin: "https://app.example.test" }],
        authorized_http_hosts: ["app.example.test", "*.api.example.test"],
        global_http_rps: 4,
      })
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("rejects a numeric limit without an authorized host", async () => {
    const workarea = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-policy-")))
    try {
      const store = new EngagementPolicyStore(workarea)
      expect(() =>
        store.prepare({
          action: "set",
          profiles: [],
          authorized_http_hosts: [],
          global_http_rps: 4,
        }),
      ).toThrow("requires authorized HTTP hosts")
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("installs one groupBy=rule ZAP budget across exact and wildcard hosts", async () => {
    const requested: URL[] = []
    let requestHeaders: Headers | undefined
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      (async (input, init) => {
        const url = new URL(String(input))
        requested.push(url)
        requestHeaders = new Headers(init?.headers)
        if (url.pathname.endsWith("getRateLimitRules/"))
          return new Response(
            JSON.stringify({
              getRateLimitRules:
                requested.length === 1
                  ? [{ description: "Cyberful engagement global HTTP budget" }]
                  : [{ description: "Cyberful engagement global HTTP budget", requestsPerSecond: 4 }],
            }),
            { status: 200 },
          )
        return new Response('{"Result":"OK"}', { status: 200 })
      }) as typeof globalThis.fetch,
    )
    try {
      await applyEngagementRateLimit(
        {
          version: 1,
          updated_at: new Date().toISOString(),
          profiles: [],
          authorized_http_hosts: ["app.example.test", "*.api.example.test"],
          global_http_rps: 4,
        },
        { proxyUrl: "http://127.0.0.1:49152", apiKey: "private-test-key" },
      )
      expect(requested.map((url) => url.pathname)).toEqual([
        "/JSON/network/view/getRateLimitRules/",
        "/JSON/network/action/removeRateLimitRule/",
        "/JSON/network/action/addRateLimitRule/",
        "/JSON/network/view/getRateLimitRules/",
      ])
      const installed = requested[2]
      expect(installed?.searchParams.get("groupBy")).toBe("rule")
      expect(installed?.searchParams.get("requestsPerSecond")).toBe("4")
      expect(installed?.searchParams.get("matchString")).toContain("app\\.example\\.test")
      expect(requestHeaders?.get("host")).toBe("zap")
    } finally {
      fetch.mockRestore()
    }
  })

  test("returns bounded structured diagnostics without leaking the API key or target URL", async () => {
    const apiKey = "private-test-key"
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "internal_error",
          message: `request failed at https://app.example.test/path?apikey=${apiKey}`,
          detail: `matchString=https://app.example.test&apikey=${apiKey}`,
        }),
        { status: 502 },
      ),
    )
    try {
      let failure: unknown
      try {
        await applyEngagementRateLimit(
          {
            version: 1,
            updated_at: new Date().toISOString(),
            profiles: [],
            authorized_http_hosts: ["app.example.test"],
            global_http_rps: 4,
          },
          { proxyUrl: "http://127.0.0.1:49152", apiKey },
        )
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(ZapRateLimitInstallError)
      const output = (failure as ZapRateLimitInstallError).toolResult()
      expect(output).toMatchObject({
        code: "zap_rate_limit_install_failed",
        http_status: 502,
        zap_code: "internal_error",
        retryable: false,
        user_action_required: false,
        policy_stored: false,
      })
      expect(JSON.stringify(output)).not.toContain(apiKey)
      expect(JSON.stringify(output)).not.toContain("app.example.test")
    } finally {
      fetch.mockRestore()
    }
  })

  test("reports a sanitized local validation shape without mislabeling it as a ZAP code", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ unexpectedRegistry: [{ secret: "must-not-cross" }] }), { status: 200 }),
    )
    try {
      let failure: unknown
      try {
        await applyEngagementRateLimit(undefined, {
          proxyUrl: "http://127.0.0.1:49152",
          apiKey: "private-test-key",
        })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(ZapRateLimitInstallError)
      const output = (failure as ZapRateLimitInstallError).toolResult()
      expect(output).toMatchObject({
        code: "zap_rate_limit_install_failed",
        validation_code: "invalid_rule_registry",
        response_shape: {
          type: "object",
          fields: { unexpectedRegistry: "array(1)" },
        },
      })
      expect(output).not.toHaveProperty("zap_code")
      expect(JSON.stringify(output)).not.toContain("must-not-cross")
    } finally {
      fetch.mockRestore()
    }
  })
})
