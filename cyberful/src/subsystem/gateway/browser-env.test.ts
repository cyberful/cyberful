// ── Gateway Browser Environment Tests ───────────────────────────
// Verifies owner-private environment loading, explicit profile decisions,
// and secret filtering for each built-in upstream process.
// → cyberful/src/subsystem/gateway/server.ts — owns these gateway boundaries.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SessionID } from "@/session/schema"

// resolveBrowserUpstreamEnv is a pure decision function; importing ./server has no load-time side effects
// (its DB client is lazy and main() only runs as an entrypoint), so a plain dynamic import is safe here.
const {
  agentBrowserRuntimeIdentity,
  agentBrowserActionFamily,
  agentBrowserPolicyError,
  agentBrowserToolDefinition,
  agentBrowserToolPublished,
  annotateAgentBrowserActivity,
  browserProfileToolDefinition,
  loadPrivateGatewayEnvironment,
  projectAgentBrowserSkillsResult,
  resolveBrowserUpstreamEnv,
  SEARCH_BROWSER_ALLOWED_DOMAINS,
  selectBrowserProfileUpstream,
  upstreamProcessEnv,
} = await import("./server")
const { browserActivity } = await import("./surface-coverage")

function environmentValue(name: string): string | undefined {
  return process.env[name]
}

test("gateway bounds agent-browser Unix socket paths independently of the session ID", () => {
  const runtime = agentBrowserRuntimeIdentity({
    sessionID: SessionID.make(`ses_${"x".repeat(80)}`),
    pid: 123_456,
    profile: "search",
    platform: "darwin",
  })
  const otherProfile = agentBrowserRuntimeIdentity({
    sessionID: SessionID.make(`ses_${"x".repeat(80)}`),
    pid: 123_456,
    profile: 1,
    platform: "darwin",
  })

  expect(Buffer.byteLength(runtime.socketPath, "utf8")).toBeLessThanOrEqual(103)
  expect(runtime.socketPath).toStartWith("/tmp/cyb-ab-")
  expect(runtime.session).not.toContain("ses_")
  expect(runtime.namespace).not.toBe(otherProfile.namespace)
})

test("gateway loads the owner-private environment file before binding its session", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cyberful-gateway-env-test-"))
  const previous = process.env.CYBERFUL_TEST_PRIVATE
  try {
    const file = path.join(directory, "environment.json")
    await writeFile(file, JSON.stringify({ CYBERFUL_TEST_PRIVATE: "loaded" }))
    delete process.env.CYBERFUL_TEST_PRIVATE
    await loadPrivateGatewayEnvironment(file)
    expect(environmentValue("CYBERFUL_TEST_PRIVATE")).toBe("loaded")
  } finally {
    if (previous === undefined) delete process.env.CYBERFUL_TEST_PRIVATE
    else process.env.CYBERFUL_TEST_PRIVATE = previous
    await rm(directory, { recursive: true, force: true })
  }
})

// Locks browser-profile routing for the one gateway owned by a phase.
describe("resolveBrowserUpstreamEnv", () => {
  const TEMP = "/tmp/expert-browser-x"
  const ARTIFACTS = "/home/u/artifacts"

  test("pinned profile with no live holder → reuse it for the login", () => {
    const r = resolveBrowserUpstreamEnv({
      dedicated: "/home/u/.chrome",
      artifactsDir: ARTIFACTS,
      restoreKey: "cyberful-profile-1",
      tempProfileDir: TEMP,
    })
    expect(r.set).toEqual({
      AGENT_BROWSER_PROFILE: "/home/u/.chrome",
      AGENT_BROWSER_DOWNLOAD_PATH: ARTIFACTS,
      AGENT_BROWSER_SCREENSHOT_DIR: ARTIFACTS,
      AGENT_BROWSER_ARGS: "--restore-last-session",
      AGENT_BROWSER_RESTORE: "cyberful-profile-1",
      AGENT_BROWSER_RESTORE_SAVE: "always",
      AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0",
    })
  })

  test("a pinned profile remains explicit and never falls back", () => {
    const r = resolveBrowserUpstreamEnv({
      dedicated: "/home/u/.chrome",
      artifactsDir: ARTIFACTS,
      restoreKey: "cyberful-profile-1",
      tempProfileDir: TEMP,
    })
    expect(r.set).toEqual({
      AGENT_BROWSER_PROFILE: "/home/u/.chrome",
      AGENT_BROWSER_DOWNLOAD_PATH: ARTIFACTS,
      AGENT_BROWSER_SCREENSHOT_DIR: ARTIFACTS,
      AGENT_BROWSER_ARGS: "--restore-last-session",
      AGENT_BROWSER_RESTORE: "cyberful-profile-1",
      AGENT_BROWSER_RESTORE_SAVE: "always",
      AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0",
    })
  })

  test("a missing target profile fails instead of selecting a temporary identity", () => {
    expect(() => resolveBrowserUpstreamEnv({ artifactsDir: ARTIFACTS, restoreKey: "cyberful-profile-1", tempProfileDir: TEMP })).toThrow(
      "target agent-browser profile path is missing",
    )
  })

  test("a target profile requires host-owned restore recovery with periodic autosave disabled", () => {
    expect(() =>
      resolveBrowserUpstreamEnv({ dedicated: "/home/u/.chrome", artifactsDir: ARTIFACTS, tempProfileDir: TEMP }),
    ).toThrow("target agent-browser restore key is missing")
  })

  test("the search profile strips proxy and persistent state behind a two-domain allowlist", () => {
    const r = resolveBrowserUpstreamEnv({
      dedicated: "/home/u/search",
      artifactsDir: "/home/u/search-artifacts",
      direct: true,
      tempProfileDir: TEMP,
    })
    expect(r.set).toEqual({
      AGENT_BROWSER_ALLOWED_DOMAINS: SEARCH_BROWSER_ALLOWED_DOMAINS.join(","),
      AGENT_BROWSER_DOWNLOAD_PATH: path.join(TEMP, "artifacts"),
      AGENT_BROWSER_SCREENSHOT_DIR: path.join(TEMP, "artifacts"),
    })
    expect(SEARCH_BROWSER_ALLOWED_DOMAINS).toEqual(["*.duckduckgo.com", "*.google.com"])
    expect(r.unset).toContain("CYBER_BROWSER_PROXY")
    expect(r.unset).toContain("AGENT_BROWSER_PROFILE")
    expect(r.unset).toContain("AGENT_BROWSER_PROXY")
    expect(r.unset).toContain("HTTP_PROXY")
    expect(r.unset).toContain("http_proxy")
  })
})

describe("browser profile tool routing", () => {
  const definition = {
    name: "agent_browser_open",
    description: "Open a URL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  }
  const call = async () => ({ content: [] })
  const candidates = [
    { def: definition, capability: "browser" as const, browserProfile: 1 as const, call },
    { def: definition, capability: "browser" as const, browserProfile: 2 as const, call },
    { def: definition, capability: "browser" as const, browserProfile: "search" as const, call },
  ]

  test("advertises one optional selector without changing the underlying browser schema", () => {
    const advertised = browserProfileToolDefinition(definition, [1, 2, "search"])
    expect(advertised.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        profile: {
          oneOf: [
            { type: "integer", enum: [1, 2] },
            { type: "string", enum: ["search"] },
          ],
          default: 1,
        },
      },
    })
    expect(definition.inputSchema.properties).not.toHaveProperty("profile")
    expect(advertised._meta).toMatchObject({
      "cyberful.dev/instruction-bundle": "agent-browser/core-mcp-managed",
    })
  })

  test("uses search when it is the only published browser identity", () => {
    const advertised = browserProfileToolDefinition(definition, ["search"])
    expect(advertised.inputSchema).toMatchObject({
      properties: { profile: { default: "search" } },
    })
    expect(selectBrowserProfileUpstream([candidates[2]!], { url: "https://example.test" })).toEqual({
      upstream: candidates[2],
      args: { url: "https://example.test" },
    })
  })

  test("removes host-owned upstream fields before adding the Cyberful profile selector", () => {
    const upstream = {
      name: "agent_browser_open",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string" },
          allowedDomains: { type: "array", items: { type: "string" } },
          session: { type: "string" },
          namespace: { type: "string" },
          restore: { type: "boolean" },
          idleTimeout: { type: "string" },
          extraArgs: { type: "array", items: { type: "string" } },
        },
        required: ["url", "session"],
      },
    }
    const sanitized = agentBrowserToolDefinition(upstream)
    const sanitizedSchema = sanitized.inputSchema as { properties: Record<string, unknown>; required: string[] }
    const profiledSchema = browserProfileToolDefinition(upstream, [1, "search"]).inputSchema as {
      properties: Record<string, unknown>
    }
    expect(sanitizedSchema.properties).toEqual({ url: { type: "string" } })
    expect(sanitizedSchema.required).toEqual(["url"])
    expect(profiledSchema.properties).toHaveProperty("profile")
  })

  test("rejects direct and nested attempts to replace host lifecycle or target egress", () => {
    expect(agentBrowserPolicyError("agent_browser_open", { session: "other" }, 1)).toContain("owned by Cyberful")
    expect(
      agentBrowserPolicyError("agent_browser_open", { allowedDomains: ["*.wolt.com"] }, "search"),
    ).toContain("owned by Cyberful")
    expect(agentBrowserPolicyError("agent_browser_connect", { endpoint: "ws://remote.test" }, 1)).toContain(
      "ZAP-pinned",
    )
    expect(agentBrowserPolicyError("agent_browser_connect", { endpoint: "ws://remote.test" }, "search")).toBeUndefined()
    expect(
      agentBrowserPolicyError("agent_browser_batch", { commands: [["open", "https://target.test", "--proxy", "direct://"]] }, 1),
    ).toContain("--proxy")
    expect(
      agentBrowserPolicyError(
        "agent_browser_batch",
        { commands: [["open", "https://target.test", "--allowed-domains=*.wolt.com"]] },
        "search",
      ),
    ).toContain("--allowed-domains")
    expect(
      agentBrowserPolicyError("agent_browser_batch", { commands: [["connect", "ws://remote.test"]] }, 1),
    ).toContain("connect")
    expect(agentBrowserPolicyError("agent_browser_batch", { commands: [["close"]] }, "search")).toContain("close")
    expect(agentBrowserPolicyError("agent_browser_dashboard_start", {}, "search")).toContain("lifecycle")
    expect(agentBrowserPolicyError("agent_browser_dashboard_stop", {}, 1)).toContain("lifecycle")
    expect(agentBrowserPolicyError("agent_browser_set_headers", { headers: { "X-Research": "operator" } }, 1)).toContain(
      "through ZAP",
    )
    expect(agentBrowserPolicyError("agent_browser_plugin_run", { name: "provider" }, 1)).toContain("only Cyberful")
    expect(
      agentBrowserPolicyError(
        "agent_browser_plugin_run",
        { name: "captcha", requestType: "captcha.solve", payload: { kind: "turnstile" } },
        1,
      ),
    ).toBeUndefined()
  })

  test("does not advertise operations that Cyberful rejects for every profile", () => {
    for (const name of [
      "agent_browser_auth_save",
      "agent_browser_auth_login",
      "agent_browser_close",
      "agent_browser_connect",
      "agent_browser_plugin_add",
      "agent_browser_set_headers",
      "agent_browser_session",
      "agent_browser_state_load",
      "agent_browser_stream_enable",
      "agent_browser_tools_profiles",
      "agent_browser_install",
    ])
      expect(agentBrowserToolPublished(name)).toBe(false)
    expect(agentBrowserToolPublished("agent_browser_snapshot")).toBe(true)
    expect(agentBrowserToolPublished("web_search")).toBe(true)
  })

  test("projects one canonical skill payload without CLI envelope copies", () => {
    const content = "---\nname: core-mcp-managed\n---\n\n# Managed MCP\n"
    const projected = projectAgentBrowserSkillsResult({
      content: [{ type: "text", text: JSON.stringify({ success: true, data: [{ name: "core-mcp-managed", content }] }) }],
      structuredContent: {
        exitCode: 0,
        stdout: JSON.stringify({ success: true, data: [{ name: "core-mcp-managed", content }] }),
        stderr: "",
        response: { success: true, data: [{ name: "core-mcp-managed", content }] },
      },
      isError: false,
    })
    expect(projected.content).toEqual([{ type: "text", text: content }])
    expect(projected.structuredContent).toBeUndefined()
    expect(JSON.stringify(projected)).not.toContain("stdout")
    expect(projected._meta).toMatchObject({
      "io.cyberful/agent-browser-skills": [
        { name: "core-mcp-managed", bytes: Buffer.byteLength(content), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ],
    })
  })

  test("defaults to profile one and strips the gateway-only selector before forwarding", () => {
    expect(selectBrowserProfileUpstream(candidates, { url: "https://example.test" })).toEqual({
      upstream: candidates[0],
      args: { url: "https://example.test" },
    })
    expect(selectBrowserProfileUpstream(candidates, { profile: 2, url: "https://example.test" })).toEqual({
      upstream: candidates[1],
      args: { url: "https://example.test" },
    })
    expect(
      selectBrowserProfileUpstream(candidates, { profile: "search", url: "https://duckduckgo.com/about" }),
    ).toEqual({
      upstream: candidates[2],
      args: { url: "https://duckduckgo.com/about" },
    })
  })

  test("rejects invalid or unavailable profile identities", () => {
    expect(() => selectBrowserProfileUpstream(candidates, { profile: "2" })).toThrow("integer from 1 through 5 or search")
    expect(() => selectBrowserProfileUpstream(candidates, { profile: 5 })).toThrow("profile 5 is unavailable")
  })

  test("forces web_search to the named profile without advertising a selector", () => {
    const searchDefinition = {
      name: "web_search",
      description: "Search DuckDuckGo.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }
    const search = { def: searchDefinition, capability: "browser" as const, browserProfile: "search" as const, call }
    const wrongProfile = { def: searchDefinition, capability: "browser" as const, browserProfile: 1 as const, call }
    expect(browserProfileToolDefinition(searchDefinition, ["search"])).toEqual({
      ...searchDefinition,
      _meta: { "cyberful.dev/eager": true },
    })
    expect(selectBrowserProfileUpstream([wrongProfile, search], { query: "CVE" })).toEqual({
      upstream: search,
      args: { query: "CVE" },
    })
    expect(() => selectBrowserProfileUpstream([wrongProfile], { query: "CVE" })).toThrow(
      "search profile is unavailable",
    )
    expect(() => selectBrowserProfileUpstream([search], { query: "CVE", profile: 1 })).toThrow(
      "does not accept a browser profile",
    )
  })
})

describe("agent-browser semantic activity", () => {
  test("classifies typed commands, find actions, and batch as one compound activity", () => {
    expect(agentBrowserActionFamily("agent_browser_open", { url: "https://example.test" })).toBe("navigation")
    expect(agentBrowserActionFamily("agent_browser_click", { selector: "@e1" })).toBe("ui_interaction")
    expect(agentBrowserActionFamily("agent_browser_find", { action: "click", text: "Save" })).toBe("ui_interaction")
    expect(agentBrowserActionFamily("agent_browser_find", { action: "fill", text: "secret" })).toBe("ui_input")
    expect(agentBrowserActionFamily("agent_browser_eval", { expression: "location.href" })).toBe("script")
    expect(agentBrowserActionFamily("agent_browser_snapshot", {})).toBe("observation")
    expect(
      agentBrowserActionFamily("agent_browser_batch", {
        commands: [["snapshot"], ["click", "@e1"], ["fill", "@e2", "secret"]],
      }),
    ).toBe("ui_input")
  })

  test("records only profile, opaque tab, action family, outcome, and reliable current origin", () => {
    const opened = annotateAgentBrowserActivity(
      { content: [{ type: "text", text: JSON.stringify({ data: { tabId: "opaque-7" } }) }] },
      "agent_browser_open",
      { url: "https://example.test/account?token=secret" },
      2,
    )
    const openedActivity = browserActivity(opened)
    expect(openedActivity).toMatchObject({
      profile: 2,
      origin: "https://example.test",
      actionFamily: "navigation",
      outcome: "ok",
    })
    expect(openedActivity?.tabID).toMatch(/^[a-f0-9]{24}$/)
    expect(JSON.stringify(opened._meta)).not.toContain("agent_browser_open")
    expect(JSON.stringify(opened._meta)).not.toContain("opaque-7")
    expect(JSON.stringify(opened._meta)).not.toContain("token")

    const failed = annotateAgentBrowserActivity(
      { content: [{ type: "text", text: "click failed" }], isError: true },
      "agent_browser_click",
      { selector: "@e9", text: "inserted secret" },
      2,
      { tabID: openedActivity!.tabID, origin: "https://example.test" },
    )
    expect(browserActivity(failed)).toMatchObject({
      tabID: openedActivity!.tabID,
      origin: "https://example.test",
      actionFamily: "ui_interaction",
      outcome: "error",
    })
    expect(JSON.stringify(failed._meta)).not.toContain("inserted secret")
    expect(JSON.stringify(failed._meta)).not.toContain("@e9")
  })
})

describe("upstreamProcessEnv", () => {
  test("confines engagement keys to their ZAP or Ghidra bridge", () => {
    const inherited = {
      PATH: "/usr/bin",
      CYBER_ZAP_API_KEY: "api-secret",
      CYBER_ZAP_MCP_KEY: "mcp-secret",
      CYBER_ZAP_SCOPE_PROMPT: "Assess https://target.example within the authorized engagement.",
      CYBER_ZAP_ALLOWED_ORIGINS: '["https://target.example"]',
      CYBER_GHIDRA_MCP_KEY: "ghidra-secret",
    }
    expect(upstreamProcessEnv("zap", inherited)).toEqual({
      PATH: "/usr/bin",
      CYBER_ZAP_API_KEY: "api-secret",
      CYBER_ZAP_MCP_KEY: "mcp-secret",
    })
    expect(upstreamProcessEnv("ghidra", inherited)).toEqual({
      PATH: "/usr/bin",
      CYBER_GHIDRA_MCP_KEY: "ghidra-secret",
    })
    expect(upstreamProcessEnv("browser", inherited)).toEqual({ PATH: "/usr/bin" })
    expect(upstreamProcessEnv("cyberful-os", inherited)).toEqual({ PATH: "/usr/bin" })
  })
})
