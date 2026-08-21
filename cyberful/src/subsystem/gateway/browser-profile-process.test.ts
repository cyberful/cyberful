// ── agent-browser Adapter Contract Tests ───────────────────────────
// Exercises catalog pagination guards and the canonical web-search composition
// without launching Chrome or making network requests.
// → cyberful/src/subsystem/gateway/browser-profile-process.ts — owns the adapter.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js"
import {
  createBrowserProfileProcess,
  listAllBrowserTools,
  PhaseBrowserToolCatalog,
  webSearchWithAgentBrowser,
} from "./browser-profile-process"

function tool(name: string): Tool {
  return { name, inputSchema: { type: "object", properties: {} } }
}

function clientWithList(
  listTools: (request?: { cursor?: string }) => Promise<{ tools: Tool[]; nextCursor?: string }>,
): Client {
  return { listTools } as unknown as Client
}

function result(data: Record<string, unknown>, isError = false, message = "ok"): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { response: { data } },
    isError,
  }
}

describe("agent-browser catalog pagination", () => {
  test("loads every page exactly once", async () => {
    const cursors: Array<string | undefined> = []
    const client = clientWithList(async (request) => {
      cursors.push(request?.cursor)
      if (!request?.cursor) return { tools: [tool("agent_browser_tools_profiles")], nextCursor: "page-2" }
      return { tools: [tool("agent_browser_open"), tool("agent_browser_skills_get")] }
    })

    expect((await listAllBrowserTools(client)).map((entry) => entry.name)).toEqual([
      "agent_browser_tools_profiles",
      "agent_browser_open",
      "agent_browser_skills_get",
    ])
    expect(cursors).toEqual([undefined, "page-2"])
  })

  test("rejects duplicate tools and repeated cursors", async () => {
    await expect(
      listAllBrowserTools(
        clientWithList(async (request) =>
          request?.cursor
            ? { tools: [tool("agent_browser_tools_profiles")] }
            : { tools: [tool("agent_browser_tools_profiles")], nextCursor: "next" },
        ),
      ),
    ).rejects.toThrow("duplicate tool")

    let page = 0
    await expect(
      listAllBrowserTools(
        clientWithList(async () => ({
          tools: [tool(page++ === 0 ? "agent_browser_tools_profiles" : "agent_browser_open")],
          nextCursor: "same",
        })),
      ),
    ).rejects.toThrow("repeated cursor")
  })

  test("rejects a catalog missing the full-profile sentinel", async () => {
    await expect(
      listAllBrowserTools(clientWithList(async () => ({ tools: [tool("agent_browser_open")] }))),
    ).rejects.toThrow("missing agent_browser_tools_profiles")
  })

  test("shares one failed discovery and preserves bounded process diagnostics", async () => {
    const ownedProcesses: number[] = []
    const catalog = new PhaseBrowserToolCatalog()
    const options = {
      label: "browser-search",
      command: [
        process.execPath,
        "-e",
        "process.stderr.write('catalog process exited before MCP initialization'); process.exit(17)",
      ] as const,
      environment: {},
      ownProcess: (pid: number) => ownedProcesses.push(pid),
    }

    const results = await Promise.allSettled([catalog.load(options), catalog.load(options)])
    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.status).toBe("rejected")
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(Error)
        expect((result.reason as Error).message).toContain("browser-search agent-browser MCP failed")
        expect((result.reason as Error).message).toContain("catalog process exited before MCP initialization")
        expect((result.reason as Error).message).toContain("pid ")
      }
    }
    expect(ownedProcesses).toHaveLength(1)
  })
})

describe("target proxy preflight", () => {
  test("fails before spawning agent-browser when ZAP is unreachable", async () => {
    const runtime = createBrowserProfileProcess({
      label: "browser-1",
      command: ["/cyberful-test-command-must-not-run"],
      environment: {
        AGENT_BROWSER_PROXY: "http://127.0.0.1:0",
        CYBER_BROWSER_PROXY_CA_SPKI: "test-spki",
      },
      ownProcess: () => {
        throw new Error("unreachable proxy must prevent process creation")
      },
    })
    try {
      await expect(runtime.call("run-a", async () => "unreachable")).rejects.toThrow(/ZAP proxy is unreachable/i)
      expect(runtime.status()).toMatchObject({ state: "disconnected", generation: 1 })
    } finally {
      await runtime.close()
    }
  })

  test("requires the engagement-owned CA before connecting a target profile", async () => {
    const runtime = createBrowserProfileProcess({
      label: "browser-1",
      command: ["/cyberful-test-command-must-not-run"],
      environment: { AGENT_BROWSER_PROXY: "http://127.0.0.1:8080" },
      ownProcess: () => undefined,
    })
    try {
      await expect(runtime.call("run-a", async () => "unreachable")).rejects.toThrow(/requires.*ZAP CA SPKI/i)
    } finally {
      await runtime.close()
    }
  })
})

describe("web_search agent-browser composition", () => {
  test("retries internally, returns structured results, and restores the previous tab", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    let evals = 0
    const client = {
      callTool: async (request: { name: string; arguments?: Record<string, unknown> }) => {
        calls.push({ name: request.name, args: request.arguments ?? {} })
        if (request.name === "agent_browser_tab_list") return result({ tabs: [{ tabId: "previous", active: true }] })
        if (request.name === "agent_browser_tab_new") return result({ tabId: "temporary" })
        if (request.name === "agent_browser_eval") {
          evals += 1
          if (evals === 1) return result({}, true, "result layout changed")
          return result({
            result: [
              { kind: "organic", title: "One", url: "https://one.example/", snippet: "First" },
              { kind: "organic", title: "Two", url: "https://two.example/", snippet: "Second" },
            ],
          })
        }
        return result({})
      },
    } as unknown as Client

    const searched = await webSearchWithAgentBrowser(client, { query: "security", max_results: 1 })
    expect(searched.isError).toBe(false)
    expect(searched.structuredContent).toMatchObject({
      engine: "duckduckgo",
      profile: "search",
      query: "security",
      count: 1,
      truncated: true,
      results: [{ rank: 1, title: "One", url: "https://one.example/" }],
    })
    expect(calls.map((call) => call.name)).toEqual([
      "agent_browser_tab_list",
      "agent_browser_tab_new",
      "agent_browser_eval",
      "agent_browser_open",
      "agent_browser_eval",
      "agent_browser_tab_close",
      "agent_browser_tab_switch",
    ])
    expect(calls.find((call) => call.name === "agent_browser_tab_new")?.args.url).toContain("html.duckduckgo.com")
    expect(calls.find((call) => call.name === "agent_browser_open")?.args.url).toContain("lite.duckduckgo.com")
    expect(calls.at(-2)?.args.tab).toBe("temporary")
    expect(calls.at(-1)?.args.tab).toBe("previous")
  })

  test("bounds a final extraction error and still closes its temporary tab", async () => {
    const calls: string[] = []
    const client = {
      callTool: async (request: { name: string }) => {
        calls.push(request.name)
        if (request.name === "agent_browser_tab_list") return result({ tabs: [] })
        if (request.name === "agent_browser_tab_new") return result({ tabId: "temporary" })
        if (request.name === "agent_browser_eval") return result({}, true, "x".repeat(2_000))
        return result({})
      },
    } as unknown as Client

    const searched = await webSearchWithAgentBrowser(client, { query: "security" })
    expect(searched.isError).toBe(true)
    expect(searched.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("bounded internal") })
    expect(JSON.stringify(searched.structuredContent).length).toBeLessThan(600)
    expect(calls.filter((name) => name === "agent_browser_eval")).toHaveLength(2)
    expect(calls.at(-1)).toBe("agent_browser_tab_close")
  })
})
