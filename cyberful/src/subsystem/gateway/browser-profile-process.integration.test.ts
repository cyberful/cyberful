// ── Real CDP Browser Controller Isolation ───────────────────────────
// Launches one real headless Chromium hub with two AgentRun controllers and
// verifies private tab ids and network logs alongside shared profile cookies.
// Owner cleanup preserves the sibling; profile close supports lazy recreation.
// → cyberful/src/subsystem/gateway/browser-profile-process.ts — launches the tested processes.
// ────────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import os from "node:os"
import path from "node:path"
import { createBrowserProfileProcess } from "./browser-profile-process"

const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-browser-controller-"))
const repositoryRoot = path.resolve(import.meta.dir, "../../../..")
const browserLauncher = path.join(repositoryRoot, "mcps", "browser", "bin", "cyber-browser")
const browserCache = path.join(repositoryRoot, "mcps", "browser", ".browsers")
const profileDir = path.join(root, "profile")
const artifactsDir = path.join(root, "artifacts")
let server: Server | undefined
let serverPort = 0

const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
)
for (const key of [
  "CYBER_BROWSER_CDP_ENDPOINT",
  "CYBER_BROWSER_EAGER",
  "CYBER_BROWSER_OWN_TAB",
  "CYBER_BROWSER_PROXY",
  "CYBER_BROWSER_PROXY_CA_SPKI",
  "CYBER_BROWSER_SHARED_ATTESTATION",
])
  delete environment[key]
Object.assign(environment, {
  CYBER_BROWSER_ARTIFACTS_DIR: artifactsDir,
  CYBER_BROWSER_BROWSERS_PATH: browserCache,
  CYBER_BROWSER_HEADLESS: "true",
  CYBER_BROWSER_PROFILE_ID: "1",
  CYBER_BROWSER_STEALTH: "false",
  CYBER_BROWSER_USER_DATA_DIR: profileDir,
})

const runtime = createBrowserProfileProcess({
  label: "browser-1",
  command: [browserLauncher],
  environment,
  profileDir,
  diagnosticSink: (message) => {
    if (process.env.CYBERFUL_TEST_BROWSER_DIAGNOSTICS === "1") process.stderr.write(message)
  },
  ownProcess: () => undefined,
})

function json(result: CallToolResult): Record<string, unknown> | unknown[] {
  const content = result.content.find((entry) => entry.type === "text")
  if (!content || content.type !== "text") throw new Error("browser test call returned no text")
  try {
    return JSON.parse(content.text) as Record<string, unknown> | unknown[]
  } catch (error) {
    throw new Error(`browser test call returned non-JSON text: ${content.text}`, { cause: error })
  }
}

function call(runID: string, name: string, args: Record<string, unknown> = {}) {
  return runtime.call(runID, async (client) => {
    const result = await client.callTool({ name, arguments: args }, CallToolResultSchema, {
      timeout: 60_000,
      maxTotalTimeout: 60_000,
    })
    return CallToolResultSchema.parse(result)
  })
}

beforeAll(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.end(`<html><body><button>${request.url ?? "/"}</button></body></html>`)
  })
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject)
    server!.listen(0, "127.0.0.1", () => {
      server!.off("error", reject)
      const address = server!.address()
      if (!address || typeof address === "string") {
        reject(new Error("browser test server returned no TCP address"))
        return
      }
      serverPort = address.port
      resolve()
    })
  })
})

afterAll(async () => {
  await runtime.close().catch(() => undefined)
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
})

describe("real shared browser profile", () => {
  test("shares cookies without sharing tabs or observed traffic", async () => {
    const base = `http://127.0.0.1:${serverPort}`
    const firstOpen = json(await call("run-a", "browser_tabs", { action: "open" })) as Record<string, unknown>
    const secondOpen = json(await call("run-b", "browser_tabs", { action: "open" })) as Record<string, unknown>
    const firstTab = firstOpen.tab_id
    const secondTab = secondOpen.tab_id
    expect(firstTab).toBeString()
    expect(secondTab).toBeString()
    expect(firstTab).not.toBe(secondTab)

    const foreign = await call("run-a", "browser_tabs", { action: "select", tab_id: secondTab })
    expect(foreign.isError).toBe(true)
    expect(foreign.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("does not exist") })

    await call("run-a", "browser_cookies", {
      action: "set",
      cookies: [{ name: "shared-session", value: "visible-to-both", url: base }],
    })
    const siblingCookies = json(
      await call("run-b", "browser_cookies", { action: "list", urls: [base] }),
    ) as Array<Record<string, unknown>>
    expect(siblingCookies).toContainEqual(expect.objectContaining({ name: "shared-session", value: "visible-to-both" }))

    await call("run-a", "browser_navigate", { url: `${base}/run-a` })
    await call("run-b", "browser_navigate", { url: `${base}/run-b` })
    expect(json(await call("run-a", "browser_network_log", { url_contains: "/run-b" }))).toMatchObject({ count: 0 })
    expect(json(await call("run-b", "browser_network_log", { url_contains: "/run-a" }))).toMatchObject({ count: 0 })

    await runtime.releaseOwner("run-a")
    expect(json(await call("run-b", "browser_status"))).toMatchObject({ active_tab_id: secondTab })

    await runtime.closeProfile()
    expect(runtime.status()).toMatchObject({ label: "browser-1", state: "disconnected" })
    expect(json(await call("run-b", "browser_tabs", { action: "list" }))).toMatchObject({ tabs: [] })
  }, 120_000)
})
