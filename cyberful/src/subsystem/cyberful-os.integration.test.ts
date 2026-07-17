// ── Live cyberful-os Capability Contract ───────────────────────────
// Starts the built image through the production phase gateway and verifies tool
// discovery plus offline in-container capabilities without emitting target traffic.
// → cyberful/src/subsystem/gateway/server.ts — exposes the tested upstream MCP path.
// ─────────────────────────────────────────────────────────────────

import { expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SubsystemPhase } from "./phase"

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../../..")
const CYBERFUL_OS_DIR = path.join(REPOSITORY_ROOT, "mcps", "cyberful-os")
const IMAGE = "cyberful-os:latest"
const ENVIRONMENT_KEYS = [
  "CYBERFUL_DB",
  "CYBERFUL_SUBSYSTEM_SESSION",
  "CYBERFUL_SUBSYSTEM_WORKFLOW",
  "CYBERFUL_SUBSYSTEM_PHASE",
  "CYBERFUL_SUBSYSTEM_LABEL",
  "CYBERFUL_SUBSYSTEM_GATEWAY_PROXY",
  "CYBERFUL_SUBSYSTEM_WORKAREA_ROOT",
  "CYBERFUL_SUBSYSTEM_HANDOFF_PATH",
  "CYBERFUL_SUBSYSTEM_QUESTION_DIR",
  "CYBERFUL_OS_DIR",
  "CYBERFUL_OS_MCP_ENABLED",
  "CYBER_BROWSER_MCP_ENABLED",
  "CYBER_ZAP_ENABLED",
  "CYBERFUL_OS_IMAGE",
  "CYBERFUL_OS_DOCKER_CONFIG",
] as const

function textContent(
  result: Awaited<
    ReturnType<InstanceType<typeof import("@modelcontextprotocol/sdk/client/index.js").Client>["callTool"]>
  >,
) {
  if (!Array.isArray(result.content)) throw new Error("cyberful-os tool returned invalid content")
  const content = result.content.find((item) => item.type === "text")
  if (!content || content.type !== "text") throw new Error("cyberful-os tool returned no text content")
  return content.text
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return Object.fromEntries(Object.entries(value))
}

function jsonRecord(value: string, label: string): Record<string, unknown> {
  try {
    return recordValue(JSON.parse(value), label)
  } catch (error) {
    throw new Error(`${label} did not return a valid JSON object`, { cause: error })
  }
}

function recordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((item, index) => recordValue(item, `${label}[${index}]`))
}

async function removeContainer(name: string) {
  const proc = Bun.spawn(["docker", "rm", "--force", "--volumes", name], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => proc.kill(), 10_000)
  try {
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    if (exitCode !== 0 && !stderr.includes("No such container"))
      throw new Error(`Docker could not remove live-test container '${name}' (exit ${exitCode}): ${stderr.trim()}`)
  } finally {
    clearTimeout(timeout)
  }
}

// ── Live Resources Preserve Primary And Cleanup Failures ───────────
// This integration owns a client, gateway, database, container, process cwd,
// environment overrides, and temporary workarea. Setup can fail after any one
// of them becomes live, so teardown attempts every acquired resource in reverse
// dependency order instead of stopping at the first cleanup error. A test-body
// failure remains the primary cause; concurrent cleanup defects are aggregated
// with it so the contract never passes with a leaked external resource.
// ───────────────────────────────────────────────────────────────

test("the built image exposes every required capability through cyberful-os and the phase gateway", async () => {
  const stderrWrite = spyOn(process.stderr, "write").mockImplementation(() => true)
  const previousCwd = process.cwd()
  const previousEnvironment = new Map(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]))
  const workarea = await mkdtemp(path.join(os.tmpdir(), "cyberful-cyberful-os-live-"))
  const container = SubsystemPhase.expertContainerName(path.resolve(workarea), "ses_cyberful_os_live")
  let client: InstanceType<typeof import("@modelcontextprotocol/sdk/client/index.js").Client> | undefined
  let gateway: Awaited<ReturnType<typeof import("./gateway/server").createGatewayServer>> | undefined
  let closeDatabase: (() => void) | undefined
  let failure: unknown
  let upstreamDiagnostics = ""

  process.chdir(workarea)
  process.env.CYBERFUL_DB = ":memory:"
  process.env.CYBERFUL_SUBSYSTEM_SESSION = "ses_cyberful_os_live"
  process.env.CYBERFUL_SUBSYSTEM_WORKFLOW = "pentest"
  process.env.CYBERFUL_SUBSYSTEM_PHASE = "recon"
  process.env.CYBERFUL_SUBSYSTEM_LABEL = "test-cyberful-os"
  process.env.CYBERFUL_SUBSYSTEM_GATEWAY_PROXY = "1"
  process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = workarea
  process.env.CYBERFUL_OS_DIR = CYBERFUL_OS_DIR
  process.env.CYBERFUL_OS_MCP_ENABLED = "1"
  process.env.CYBER_BROWSER_MCP_ENABLED = "0"
  process.env.CYBER_ZAP_ENABLED = "0"
  process.env.CYBERFUL_OS_IMAGE = IMAGE
  process.env.CYBERFUL_OS_DOCKER_CONFIG = path.join(workarea, ".docker")
  delete process.env.CYBERFUL_SUBSYSTEM_HANDOFF_PATH
  delete process.env.CYBERFUL_SUBSYSTEM_QUESTION_DIR

  try {
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js")
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
    const { createGatewayServer } = await import("./gateway/server")
    const { Database } = await import("../storage/db")
    closeDatabase = Database.close

    gateway = await createGatewayServer({
      upstreamDiagnosticSink: (text) => {
        upstreamDiagnostics = `${upstreamDiagnostics}${text}`.slice(-64 * 1024)
      },
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await gateway.connect(serverTransport)
    client = new Client({ name: "cyberful-os-live-test", version: "0.1.0" })
    await client.connect(clientTransport)

    const exposed = (await client.listTools()).tools.map((tool) => tool.name)
    const attestationResult = await client.callTool({ name: "capability_attestation", arguments: {} })
    expect(attestationResult.isError).not.toBe(true)
    const attestationText = textContent(attestationResult)
    const attestation = jsonRecord(attestationText, "capability_attestation")
    if (typeof attestation.status !== "string") {
      throw new Error(`capability_attestation omitted status: ${attestationText.slice(0, 1_000)}`)
    }
    expect(attestation.status).toBe("available")
    expect(attestation.missing).toEqual([])
    expect(attestation.failed_smoke).toEqual([])
    const smoke = recordValue(attestation.smoke, "capability_attestation.smoke")
    expect(recordValue(smoke.nuclei, "capability_attestation.smoke.nuclei").ok).toBe(true)
    expect(recordValue(smoke.metasploit, "capability_attestation.smoke.metasploit").ok).toBe(true)
    const attestedTools = recordArray(attestation.tools, "capability_attestation.tools")
    expect(
      attestedTools
        .filter((tool) => tool.optional === false)
        .every((tool) => tool.status === "available" && typeof tool.path === "string" && tool.path.length > 0),
    ).toBe(true)

    const inventoryResult = await client.callTool({ name: "tool_inventory", arguments: {} })
    expect(inventoryResult.isError).not.toBe(true)
    const inventory = jsonRecord(textContent(inventoryResult), "tool_inventory")
    const inventoryTools = recordArray(inventory.tools, "tool_inventory.tools")
    if (typeof inventory.count !== "number" || !Number.isSafeInteger(inventory.count)) {
      throw new Error("tool_inventory.count must be a safe integer")
    }
    const inventoryToolNames = inventoryTools.map((tool, index) => {
      if (typeof tool.name !== "string") throw new Error(`tool_inventory.tools[${index}].name must be a string`)
      return tool.name
    })
    expect(inventory.count).toBe(inventoryTools.length)
    expect(new Set(inventoryToolNames).size).toBe(inventory.count)
    expect(
      inventoryTools
        .filter((tool) => (tool.kind === "cli" || tool.kind === "library") && !tool.optional)
        .every((tool) => tool.installed === true),
    ).toBe(true)
    const installedInventoryNames = inventoryTools.flatMap((tool, index) => {
      const name = inventoryToolNames[index]
      if (!name) throw new Error(`tool_inventory.tools[${index}].name must be non-empty`)
      return tool.installed === false ? [] : [name]
    })
    expect(exposed.toSorted()).toEqual(["variable", ...installedInventoryNames].toSorted())
    expect(exposed).not.toContain("jeb")

    const parseResult = await client.callTool({
      name: "bs4",
      arguments: { html: "<main><h1>cyberful-live</h1></main>", selector: "h1" },
    })
    expect(parseResult.isError).not.toBe(true)
    expect(textContent(parseResult)).toContain("cyberful-live")
  } catch (error) {
    const detail = upstreamDiagnostics.trim()
    failure = detail
      ? new Error(`${error instanceof Error ? error.message : String(error)}\ncyberful-os diagnostics:\n${detail}`, {
          cause: error,
        })
      : error
  } finally {
    const cleanupErrors: unknown[] = []
    const attempt = async (operation: (() => void | Promise<void>) | undefined) => {
      if (!operation) return
      try {
        await operation()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    const activeClient = client
    const activeGateway = gateway
    await attempt(activeClient ? () => activeClient.close() : undefined)
    await attempt(activeGateway ? () => activeGateway.closeGateway() : undefined)
    await attempt(closeDatabase)
    await attempt(() => removeContainer(container))
    await attempt(() => process.chdir(previousCwd))
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await attempt(() => rm(workarea, { recursive: true, force: true }))
    stderrWrite.mockRestore()

    const failures = failure === undefined ? cleanupErrors : [failure, ...cleanupErrors]
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, "cyberful-os live test and cleanup failed")
  }
}, 300_000)
