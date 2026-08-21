// ── Real agent-browser Profile Isolation ────────────────────────────
// Launches two native agent-browser MCP profiles and verifies phase-shared
// state, cross-profile isolation, serialized calls, and lazy daemon recreation.
// → cyberful/src/subsystem/gateway/browser-profile-process.ts — owns the processes.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import os from "node:os"
import path from "node:path"
import { createBrowserProfileProcess, PhaseBrowserToolCatalog } from "./browser-profile-process"
import { agentBrowserToolPublished } from "./server"

const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-agent-browser-"))
const repositoryRoot = path.resolve(import.meta.dir, "../../../..")
const browserLauncher = path.join(repositoryRoot, "mcps", "browser", "bin", "cyber-browser")
const captchaPlugin = path.join(repositoryRoot, "mcps", "browser", "bin", "agent-browser-plugin-captcha")
const socketRoot = process.platform === "win32" ? root : "/tmp"
const socketDirectories = [
  path.join(socketRoot, `cyb-ab-it-${process.pid}-1`),
  path.join(socketRoot, `cyb-ab-it-${process.pid}-2`),
]
const namespaces = [`it${process.pid}-1`, `it${process.pid}-2`]
const restoreKeys = [`cyb-ab-it-${process.pid}-1`, `cyb-ab-it-${process.pid}-2`]
const nativeSessionSocketDirectory = path.join(socketRoot, `cyb-ab-it-${process.pid}-session`)
const nativeSessionNamespace = `it${process.pid}-session`
const searchSocketDirectory = path.join(socketRoot, `cyb-ab-it-${process.pid}-search`)
const searchNamespace = `it${process.pid}-search`
let server: Server | undefined
let serverPort = 0

function environment(profile: number): Record<string, string> {
  const artifacts = path.join(root, `artifacts-${profile}`)
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    AGENT_BROWSER_PROFILE: path.join(root, `profile-${profile}`),
    AGENT_BROWSER_DOWNLOAD_PATH: artifacts,
    AGENT_BROWSER_SCREENSHOT_DIR: artifacts,
    AGENT_BROWSER_SESSION: `it${profile}`,
    AGENT_BROWSER_NAMESPACE: namespaces[profile - 1]!,
    AGENT_BROWSER_RESTORE: restoreKeys[profile - 1]!,
    AGENT_BROWSER_RESTORE_SAVE: "always",
    AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0",
    AGENT_BROWSER_SOCKET_DIR: socketDirectories[profile - 1]!,
    AGENT_BROWSER_HEADED: "0",
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
    AGENT_BROWSER_PLUGINS: JSON.stringify([
      { name: "captcha", command: captchaPlugin, capabilities: ["command.run", "captcha.solve"] },
    ]),
  }
}

function searchEnvironment(): Record<string, string> {
  const artifacts = path.join(root, "artifacts-search")
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    AGENT_BROWSER_ALLOWED_DOMAINS: "*.duckduckgo.com,*.google.com",
    AGENT_BROWSER_DOWNLOAD_PATH: artifacts,
    AGENT_BROWSER_SCREENSHOT_DIR: artifacts,
    AGENT_BROWSER_SESSION: "it-search",
    AGENT_BROWSER_NAMESPACE: searchNamespace,
    AGENT_BROWSER_SOCKET_DIR: searchSocketDirectory,
    AGENT_BROWSER_HEADED: "0",
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
    AGENT_BROWSER_PLUGINS: JSON.stringify([
      { name: "captcha", command: captchaPlugin, capabilities: ["command.run", "captcha.solve"] },
    ]),
  }
}

const runtimes = [1, 2].map((profile) =>
  createBrowserProfileProcess({
    label: `browser-${profile}`,
    command: [browserLauncher, "mcp"],
    environment: environment(profile),
    diagnosticSink: (message) => {
      if (process.env.CYBERFUL_TEST_BROWSER_DIAGNOSTICS === "1") process.stderr.write(message)
    },
    ownProcess: () => undefined,
  }),
)

function response(result: CallToolResult): Record<string, unknown> {
  if (result.isError) {
    const content = result.content.find((entry) => entry.type === "text")
    throw new Error(content?.type === "text" ? content.text : "agent-browser integration call failed")
  }
  const structured = result.structuredContent
  if (!structured || typeof structured !== "object" || Array.isArray(structured))
    throw new Error("agent-browser integration call returned no structured content")
  const response = (structured as Record<string, unknown>).response
  if (!response || typeof response !== "object" || Array.isArray(response))
    throw new Error("agent-browser integration call returned no structured response")
  return response as Record<string, unknown>
}

function data(result: CallToolResult): Record<string, unknown> {
  const value = response(result).data
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function call(
  profile: number,
  runID: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return runtimes[profile - 1]!.call(runID, async (client) => {
    const result = await client.callTool({ name, arguments: args }, CallToolResultSchema, {
      timeout: 60_000,
      maxTotalTimeout: 60_000,
    })
    return CallToolResultSchema.parse(result)
  })
}

function cookies(value: Record<string, unknown>): readonly Record<string, unknown>[] {
  return Array.isArray(value.cookies)
    ? value.cookies.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    : []
}

beforeAll(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.end(`<html><head><title>agent-browser integration</title></head><body>${request.url ?? "/"}</body></html>`)
  })
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject)
    server!.listen(0, "127.0.0.1", () => {
      server!.off("error", reject)
      const address = server!.address()
      if (!address || typeof address === "string") return reject(new Error("browser test server has no TCP address"))
      serverPort = address.port
      resolve()
    })
  })
})

afterAll(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.close().catch(() => undefined)))
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  await Promise.all(socketDirectories.map((directory) => rm(directory, { recursive: true, force: true })))
  await Promise.all(
    [...namespaces, nativeSessionNamespace, searchNamespace].map((namespace) =>
      rm(path.join(os.homedir(), ".agent-browser", "namespaces", namespace), { recursive: true, force: true }),
    ),
  )
  await rm(nativeSessionSocketDirectory, { recursive: true, force: true })
  await rm(searchSocketDirectory, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
})

describe("real agent-browser profiles", () => {
  test("discovers the production plugin catalog once and starts the managed search runtime", async () => {
    const options = {
      label: "browser-search",
      command: [browserLauncher, "mcp"] as const,
      environment: searchEnvironment(),
      cleanupDirectory: path.join(root, "profile-search"),
      diagnosticSink: (message: string) => {
        if (process.env.CYBERFUL_TEST_BROWSER_DIAGNOSTICS === "1") process.stderr.write(message)
      },
      ownProcess: () => undefined,
    }
    const catalogOwner = new PhaseBrowserToolCatalog()
    const tools = await catalogOwner.load(options)
    expect(tools).toHaveLength(152)
    expect(tools.filter((tool) => agentBrowserToolPublished(tool.name))).toHaveLength(117)
    expect(tools.some((tool) => tool.name === "agent_browser_tools_profiles")).toBe(true)
    expect(tools.some((tool) => tool.name === "agent_browser_plugin_run")).toBe(true)

    const runtime = createBrowserProfileProcess(options)
    try {
      expect(await runtime.health()).toMatchObject({ label: "browser-search", state: "ready" })
      const plugin = await runtime.call("plugin-check", async (client) => {
        const result = await client.callTool(
          { name: "agent_browser_plugin_show", arguments: { name: "captcha" } },
          CallToolResultSchema,
          { timeout: 60_000, maxTotalTimeout: 60_000 },
        )
        return CallToolResultSchema.parse(result)
      })
      expect(response(plugin)).toMatchObject({
        plugin: {
          name: "captcha",
          command: captchaPlugin,
          capabilities: ["command.run", "captcha.solve"],
        },
      })
      const blocked = await runtime.call("allowlist-check", async (client) => {
        const result = await client.callTool(
          { name: "agent_browser_open", arguments: { url: `http://127.0.0.1:${serverPort}/blocked` } },
          CallToolResultSchema,
          { timeout: 60_000, maxTotalTimeout: 60_000 },
        )
        return CallToolResultSchema.parse(result)
      })
      expect(blocked.isError).toBe(true)
      expect(JSON.stringify(blocked)).toContain("not in the allowed domains list")
    } finally {
      await runtime.close()
    }
  }, 60_000)

  test("share one serialized session per profile while isolating different profiles", async () => {
    const base = `http://127.0.0.1:${serverPort}`
    data(await call(1, "run-a", "agent_browser_open", { url: `${base}/shared` }))
    expect(data(await call(1, "run-b", "agent_browser_get_url")).url).toBe(`${base}/shared`)
    expect(data(await call(1, "run-b", "agent_browser_eval", { script: "navigator.webdriver" })).result).toBe(false)

    data(
      await call(1, "run-a", "agent_browser_cookies_set", {
        name: "shared-session",
        value: "visible-to-profile-one",
        url: base,
      }),
    )
    expect(cookies(data(await call(1, "run-b", "agent_browser_cookies_get")))).toContainEqual(
      expect.objectContaining({ name: "shared-session", value: "visible-to-profile-one" }),
    )

    data(await call(2, "run-c", "agent_browser_open", { url: `${base}/isolated` }))
    expect(data(await call(2, "run-c", "agent_browser_get_url")).url).toBe(`${base}/isolated`)
    expect(cookies(data(await call(2, "run-c", "agent_browser_cookies_get")))).not.toContainEqual(
      expect.objectContaining({ name: "shared-session" }),
    )
    expect(data(await call(1, "run-b", "agent_browser_get_url")).url).toBe(`${base}/shared`)

    await Promise.all([
      call(1, "run-a", "agent_browser_open", { url: `${base}/serial-a` }),
      call(1, "run-b", "agent_browser_open", { url: `${base}/serial-b` }),
    ])
    expect(data(await call(1, "run-a", "agent_browser_get_url")).url).toBe(`${base}/serial-b`)

    await runtimes[0]!.closeProfile()
    expect(runtimes[0]!.status()).toMatchObject({ label: "browser-1", state: "disconnected" })
    data(await call(1, "run-b", "agent_browser_open", { url: `${base}/recreated` }))
    expect(data(await call(1, "run-a", "agent_browser_get_url")).url).toBe(`${base}/recreated`)
    expect(cookies(data(await call(1, "run-a", "agent_browser_cookies_get")))).toContainEqual(
      expect.objectContaining({ name: "shared-session", value: "visible-to-profile-one" }),
    )
  }, 120_000)

  test("retain native session cookies across a clean daemon restart", async () => {
    const artifacts = path.join(root, "native-session-artifacts")
    const runtime = createBrowserProfileProcess({
      label: "browser-1",
      command: [browserLauncher, "mcp"],
      environment: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        AGENT_BROWSER_PROFILE: path.join(root, "native-session-profile"),
        AGENT_BROWSER_DOWNLOAD_PATH: artifacts,
        AGENT_BROWSER_SCREENSHOT_DIR: artifacts,
        AGENT_BROWSER_SESSION: "it-session",
        AGENT_BROWSER_NAMESPACE: nativeSessionNamespace,
        AGENT_BROWSER_SOCKET_DIR: nativeSessionSocketDirectory,
        AGENT_BROWSER_HEADED: "0",
        AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
        AGENT_BROWSER_ARGS: "--restore-last-session",
      },
      diagnosticSink: (message) => {
        if (process.env.CYBERFUL_TEST_BROWSER_DIAGNOSTICS === "1") process.stderr.write(message)
      },
      ownProcess: () => undefined,
    })
    const invoke = (name: string, args: Record<string, unknown> = {}) =>
      runtime.call("native-session", async (client) => {
        const result = await client.callTool({ name, arguments: args }, CallToolResultSchema, {
          timeout: 60_000,
          maxTotalTimeout: 60_000,
        })
        return CallToolResultSchema.parse(result)
      })
    const base = `http://127.0.0.1:${serverPort}`

    try {
      data(await invoke("agent_browser_open", { url: `${base}/native-session` }))
      data(
        await invoke("agent_browser_cookies_set", {
          name: "native-session",
          value: "survives-clean-restart",
          url: base,
        }),
      )
      expect(cookies(data(await invoke("agent_browser_cookies_get")))).toContainEqual(
        expect.objectContaining({ name: "native-session", session: true }),
      )

      await runtime.closeProfile()
      data(await invoke("agent_browser_open", { url: `${base}/native-session-restarted` }))
      expect(cookies(data(await invoke("agent_browser_cookies_get")))).toContainEqual(
        expect.objectContaining({ name: "native-session", value: "survives-clean-restart", session: true }),
      )
    } finally {
      await runtime.close()
    }
  }, 120_000)
})
