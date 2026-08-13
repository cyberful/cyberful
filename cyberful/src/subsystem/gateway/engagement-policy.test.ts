// ── Host-Enforced Engagement Policy Tests ──────────────────────
// Verifies staged persistence, public-header validation, and exact ZAP
//   installation and attestation across both owned rule registries.
// → cyberful/src/subsystem/gateway/engagement-policy.ts — owns the policy.
// ───────────────────────────────────────────────────────────────

import { describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  applyEngagementTrafficPolicy,
  ENGAGEMENT_POLICY_PATH,
  EngagementPolicyStore,
  readEngagementPolicy,
  ZapEngagementPolicyInstallError,
} from "./engagement-policy"

function policy() {
  return {
    version: 1 as const,
    stage: "traffic" as const,
    updated_at: new Date().toISOString(),
    profiles: [],
    authorized_http_hosts: ["app.example.test", "*.api.example.test"],
    global_http_rps: 4,
    required_http_headers: [
      { name: "X-Request-Purpose", value: "Research", hosts: ["app.example.test"] },
    ],
  }
}

function statefulZap() {
  const requested: URL[] = []
  let requestHeaders: Headers | undefined
  let rateRules: Record<string, unknown>[] = [
    { description: "Cyberful engagement global HTTP budget", requestsPerSecond: 8 },
  ]
  let headerRules: Record<string, unknown>[] = [
    {
      description: "Cyberful engagement required header: stale",
      enabled: true,
      matchType: "REQ_HEADER",
      matchRegex: false,
      matchString: "Stale",
      replacement: "stale",
      url: "stale",
    },
  ]
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    (async (input, init) => {
      const url = new URL(String(input))
      requested.push(url)
      requestHeaders = new Headers(init?.headers)
      if (url.pathname.endsWith("getRateLimitRules/"))
        return new Response(JSON.stringify({ getRateLimitRules: rateRules }), { status: 200 })
      if (url.pathname.endsWith("removeRateLimitRule/")) {
        rateRules = rateRules.filter((rule) => rule.description !== url.searchParams.get("description"))
        return new Response('{"Result":"OK"}', { status: 200 })
      }
      if (url.pathname.endsWith("addRateLimitRule/")) {
        rateRules.push({
          description: url.searchParams.get("description"),
          enabled: url.searchParams.get("enabled"),
          matchRegex: url.searchParams.get("matchRegex"),
          matchString: url.searchParams.get("matchString"),
          requestsPerSecond: Number(url.searchParams.get("requestsPerSecond")),
          groupBy: url.searchParams.get("groupBy"),
        })
        return new Response('{"Result":"OK"}', { status: 200 })
      }
      if (url.pathname.endsWith("replacer/view/rules/"))
        return new Response(JSON.stringify({ rules: headerRules }), { status: 200 })
      if (url.pathname.endsWith("replacer/action/removeRule/")) {
        headerRules = headerRules.filter((rule) => rule.description !== url.searchParams.get("description"))
        return new Response('{"Result":"OK"}', { status: 200 })
      }
      if (url.pathname.endsWith("replacer/action/addRule/")) {
        headerRules.push({
          description: url.searchParams.get("description"),
          enabled: url.searchParams.get("enabled"),
          matchType: url.searchParams.get("matchType"),
          matchRegex: url.searchParams.get("matchRegex"),
          matchString: url.searchParams.get("matchString"),
          replacement: url.searchParams.get("replacement"),
          url: url.searchParams.get("url"),
        })
        return new Response('{"Result":"OK"}', { status: 200 })
      }
      return new Response('{"code":"unexpected_path"}', { status: 500 })
    }) as typeof globalThis.fetch,
  )
  return {
    fetch,
    requested,
    requestHeaders: () => requestHeaders,
    rateRules: () => rateRules,
    headerRules: () => headerRules,
  }
}

describe("engagement policy", () => {
  test("persists traffic controls before final profile readiness", async () => {
    const workarea = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-policy-")))
    try {
      const store = new EngagementPolicyStore(workarea)
      const traffic = store.prepareTraffic({
        action: "configure",
        authorized_http_hosts: ["app.example.test", "*.api.example.test"],
        global_http_rps: null,
        required_http_headers: [
          { name: "X-Request-Purpose", value: "Research", hosts: ["app.example.test"] },
        ],
      })
      await store.commit(traffic)
      expect(await readEngagementPolicy(workarea)).toMatchObject({
        stage: "traffic",
        profiles: [],
        required_http_headers: [{ name: "X-Request-Purpose", value: "Research" }],
      })

      const final = store.finalize(await store.get(), {
        action: "finalize",
        profiles: [{ profile: 2, readiness: "READY", scope: "IN_SCOPE", origin: "https://app.example.test/home" }],
      })
      await store.commit(final)
      expect(await readEngagementPolicy(workarea)).toMatchObject({
        stage: "final",
        profiles: [{ profile: 2, origin: "https://app.example.test" }],
        authorized_http_hosts: ["app.example.test", "*.api.example.test"],
      })
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("reads legacy policies as final policies without required headers", async () => {
    const workarea = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-policy-")))
    try {
      const target = path.join(workarea, ENGAGEMENT_POLICY_PATH)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(
        target,
        JSON.stringify({
          version: 1,
          updated_at: new Date().toISOString(),
          profiles: [],
          authorized_http_hosts: ["app.example.test"],
          global_http_rps: null,
        }),
      )
      expect(await readEngagementPolicy(workarea)).toMatchObject({
        stage: "final",
        required_http_headers: [],
      })
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("rejects unenforceable or secret-bearing traffic controls", async () => {
    const workarea = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-policy-")))
    try {
      const store = new EngagementPolicyStore(workarea)
      expect(() =>
        store.prepareTraffic({
          action: "configure",
          authorized_http_hosts: [],
          global_http_rps: 4,
          required_http_headers: [],
        }),
      ).toThrow("requires authorized HTTP hosts")
      expect(() =>
        store.prepareTraffic({
          action: "configure",
          authorized_http_hosts: ["app.example.test"],
          global_http_rps: null,
          required_http_headers: [
            { name: "Authorization", value: "public", hosts: ["app.example.test"] },
          ],
        }),
      ).toThrow("non-secret public header")
      expect(() =>
        store.prepareTraffic({
          action: "configure",
          authorized_http_hosts: ["*.example.test"],
          global_http_rps: null,
          required_http_headers: [
            { name: "X-Request-Purpose", value: "Research", hosts: ["other.test"] },
          ],
        }),
      ).toThrow("covered by authorized_http_hosts")
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("installs and attests one aggregate budget plus one host-scoped public header", async () => {
    const zap = statefulZap()
    try {
      const enforcement = await applyEngagementTrafficPolicy(policy(), {
        proxyUrl: "http://127.0.0.1:49152",
        apiKey: "private-test-key",
      })
      expect(enforcement).toEqual({
        state: "enforced",
        rate_limit: {
          state: "configured",
          requests_per_second: 4,
          hosts: ["app.example.test", "*.api.example.test"],
          group_by: "rule",
        },
        required_headers: {
          state: "configured",
          count: 1,
          names: ["X-Request-Purpose"],
          hosts: ["app.example.test"],
        },
      })
      const rateRequest = zap.requested.find((url) => url.pathname.endsWith("addRateLimitRule/"))
      expect(rateRequest?.searchParams.get("groupBy")).toBe("rule")
      expect(rateRequest?.searchParams.get("matchString")).toContain("app\\.example\\.test")
      const headerRequest = zap.requested.find((url) => url.pathname.endsWith("replacer/action/addRule/"))
      expect(headerRequest?.searchParams.get("matchType")).toBe("REQ_HEADER")
      expect(headerRequest?.searchParams.get("matchRegex")).toBe("false")
      expect(headerRequest?.searchParams.get("matchString")).toBe("X-Request-Purpose")
      expect(headerRequest?.searchParams.get("replacement")).toBe("Research")
      expect(headerRequest?.searchParams.get("url")).toContain("app\\.example\\.test")
      expect(zap.requestHeaders()?.get("host")).toBe("zap")
      expect(zap.rateRules()).toHaveLength(1)
      expect(zap.headerRules()).toHaveLength(1)
    } finally {
      zap.fetch.mockRestore()
    }
  })

  test("attests absent limits and headers as not required after removing stale rules", async () => {
    const zap = statefulZap()
    try {
      const enforcement = await applyEngagementTrafficPolicy(undefined, {
        proxyUrl: "http://127.0.0.1:49152",
        apiKey: "private-test-key",
      })
      expect(enforcement).toEqual({
        state: "enforced",
        rate_limit: { state: "not_required" },
        required_headers: { state: "not_required", count: 0 },
      })
      expect(zap.rateRules()).toEqual([])
      expect(zap.headerRules()).toEqual([])
    } finally {
      zap.fetch.mockRestore()
    }
  })

  test("returns bounded structured diagnostics without leaking the API key or target URL", async () => {
    const apiKey = "private-test-key"
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "internal_error",
          message: `request failed at https://app.example.test/path?apikey=${apiKey}`,
          detail: `replacement=Research&apikey=${apiKey}`,
        }),
        { status: 502 },
      ),
    )
    try {
      let failure: unknown
      try {
        await applyEngagementTrafficPolicy(policy(), {
          proxyUrl: "http://127.0.0.1:49152",
          apiKey,
        })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(ZapEngagementPolicyInstallError)
      const output = (failure as ZapEngagementPolicyInstallError).toolResult()
      expect(output).toMatchObject({
        code: "zap_engagement_policy_install_failed",
        http_status: 502,
        zap_code: "internal_error",
        retryable: false,
        user_action_required: false,
        policy_stored: false,
      })
      expect(JSON.stringify(output)).not.toContain(apiKey)
      expect(JSON.stringify(output)).not.toContain("app.example.test")
      expect(JSON.stringify(output)).not.toContain("Research")
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
        await applyEngagementTrafficPolicy(undefined, {
          proxyUrl: "http://127.0.0.1:49152",
          apiKey: "private-test-key",
        })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(ZapEngagementPolicyInstallError)
      const output = (failure as ZapEngagementPolicyInstallError).toolResult()
      expect(output).toMatchObject({
        code: "zap_engagement_policy_install_failed",
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
