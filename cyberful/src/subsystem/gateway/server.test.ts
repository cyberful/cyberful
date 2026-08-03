// ── Phase Gateway Server Tests ────────────────────────────────────
// Verifies gateway scope, phase handoffs, tool policy, upstream proxying, question
// bridging, and local service cleanup through the real MCP server contract.
// → cyberful/src/subsystem/gateway/server.ts — owns the tested gateway lifecycle.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { SessionID } from "../../session/schema"
import { ProjectID } from "../../project/schema"
import type { UpstreamTool } from "./server"
import { isRecord } from "@/util/record"
import type { ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js"

// Exercise the real database layer without touching the developer database. Flag.CYBERFUL_DB is
// captured at module load, so set it before the dynamic imports below and run test files isolated.
const SESSION = SessionID.make("ses_gwtest")
const PROJECT = ProjectID.make("prj_gwtest")
const previousDatabase = process.env.CYBERFUL_DB
process.env.CYBERFUL_DB = ":memory:"
process.env.CYBERFUL_SUBSYSTEM_SESSION = SESSION
const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)

// Imports below open nothing at load time (the DB client is lazy), so the env above is in effect
// by the time the gateway or the seed first touch the database.
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js")
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
const { Server } = await import("@modelcontextprotocol/sdk/server/index.js")
const {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ElicitRequestSchema,
} = await import("@modelcontextprotocol/sdk/types.js")
const {
  claimGatewayPidSignal,
  createGatewayServer,
  parentUnavailable,
  runtimeCapabilityAllowed,
  runtimeNetworkAllowed,
  writeGatewayPidSignal,
} = await import("./server")
const { humanDecisionMetadata } = await import("../human-question")
const { activateCircuitBreaker, readCircuitBreaker } = await import("./circuit-breaker")
const { Database } = await import("../../storage/db")
const { SessionTable } = await import("../../session/session.sql")
const { ProjectTable } = await import("../../project/project.sql")
const { SessionVariableTable } = await import("../../session/session.sql")
const { eq, and } = await import("drizzle-orm")

// The gateway writes session_variable rows; those FK to session → project, so a bare variable insert
// would fail. Seed the parents so the round-trip exercises the real (foreign-key-on) path.
function seedSessionRow() {
  Database.use((db: import("../../storage/db").TxOrDb) => {
    db.insert(ProjectTable).values({ id: PROJECT, worktree: "/tmp/gw" }).run()
    db.insert(SessionTable)
      .values({ id: SESSION, project_id: PROJECT, slug: "gw", directory: "/tmp/gw", title: "gw", version: "0" })
      .run()
  })
}

// Remove this test's rows so a shared-DB run is idempotent (re-runs never hit UNIQUE constraints)
// and leaves nothing behind. Runs before seeding and after the suite.
function cleanupTestRows() {
  Database.transaction((db: import("../../storage/db").TxOrDb) => {
    db.delete(SessionVariableTable).where(eq(SessionVariableTable.session_id, SESSION)).run()
    db.delete(SessionTable).where(eq(SessionTable.id, SESSION)).run()
    db.delete(ProjectTable).where(eq(ProjectTable.id, PROJECT)).run()
  })
}

type McpClient = InstanceType<typeof Client>
type CallToolResult = Awaited<ReturnType<McpClient["callTool"]>>

function textContent(result: CallToolResult) {
  if (!Array.isArray(result.content)) throw new Error("tool returned invalid content")
  const content = result.content[0]
  if (
    typeof content !== "object" ||
    content === null ||
    !("type" in content) ||
    content.type !== "text" ||
    !("text" in content) ||
    typeof content.text !== "string"
  )
    throw new Error("tool returned no text content")
  return content.text
}

function recordValue(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} is not an object`)
  return value
}

function recordArray(value: unknown, context: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${context} is not an array`)
  return value.map((item) => recordValue(item, `${context} item`))
}

function jsonContent(result: CallToolResult) {
  return recordValue(JSON.parse(textContent(result)), "tool JSON content")
}

function errorContent(result: CallToolResult) {
  return recordValue(jsonContent(result).error, "tool contract error")
}

async function callVariable(client: McpClient, args: Record<string, unknown>) {
  const res = await client.callTool({ name: "variable", arguments: args })
  return jsonContent(res)
}

let client: McpClient
let gateway: Awaited<ReturnType<typeof createGatewayServer>>

beforeAll(async () => {
  cleanupTestRows()
  seedSessionRow()
  gateway = await createGatewayServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await gateway.connect(serverTransport)
  client = new Client({ name: "gw-test", version: "0" })
  await client.connect(clientTransport)
})

afterAll(async () => {
  const failures: unknown[] = []
  try {
    const results = await Promise.allSettled([client.close(), gateway.closeGateway()])
    failures.push(...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])))
    try {
      cleanupTestRows()
    } catch (error) {
      failures.push(error)
    }
    try {
      Database.close()
    } catch (error) {
      failures.push(error)
    }
  } finally {
    if (previousDatabase === undefined) delete process.env.CYBERFUL_DB
    else process.env.CYBERFUL_DB = previousDatabase
    stderr.mockRestore()
  }
  if (failures.length > 0) throw new AggregateError(failures, "gateway test cleanup failed")
})

describe("expert-gateway variable tool", () => {
  test("exposes variable storage and its description limit as the base tool surface", async () => {
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(["variable"])
    const inputSchema = recordValue(tools[0]?.inputSchema, "variable input schema")
    const properties = recordValue(inputSchema.properties, "variable input properties")
    expect(recordValue(properties.description, "variable description schema").maxLength).toBe(500)
  })

  test("set persists to the shared session_variable table", async () => {
    const out = await callVariable(client, {
      action: "set",
      name: "ADMIN_JWT",
      value: "secret-token-value-1234",
      description: "admin session token",
    })
    expect(out.ok).toBe(true)
    expect(recordValue(out.variable, "stored variable").name).toBe("ADMIN_JWT")

    // The Agent reads the same table for {{var:name}} resolution — assert the row is really there.
    const row = Database.use((db: import("../../storage/db").TxOrDb) =>
      db
        .select()
        .from(SessionVariableTable)
        .where(and(eq(SessionVariableTable.session_id, SESSION), eq(SessionVariableTable.name, "ADMIN_JWT")))
        .get(),
    )
    expect(row?.value).toBe("secret-token-value-1234")
  })

  test("set accepts a 500-character description and rejects a longer replacement", async () => {
    const description = "d".repeat(500)
    const accepted = await callVariable(client, {
      action: "set",
      name: "TARGET_PRIVATE_PATH",
      value: "/private/target/path",
      description,
    })
    expect(accepted.ok).toBe(true)
    expect(recordValue(accepted.variable, "stored variable").description).toBe(description)

    const rejected = await client.callTool({
      name: "variable",
      arguments: {
        action: "set",
        name: "TARGET_PRIVATE_PATH",
        value: "/replacement/path",
        description: "d".repeat(501),
      },
    })
    expect(rejected.isError).toBe(true)
    expect(jsonContent(rejected).error).toContain("at most 500 characters")

    const stored = await callVariable(client, { action: "get", name: "TARGET_PRIVATE_PATH", reveal: true })
    expect(stored.value).toBe("/private/target/path")
  })

  test("list and default get redact the raw value", async () => {
    const list = await callVariable(client, { action: "list" })
    const names = recordArray(list.variables, "listed variables").map((variable) => variable.name)
    expect(names).toContain("ADMIN_JWT")
    expect(JSON.stringify(list)).not.toContain("secret-token-value-1234")

    const got = await callVariable(client, { action: "get", name: "ADMIN_JWT" })
    expect(got.name).toBe("ADMIN_JWT")
    expect(JSON.stringify(got)).not.toContain("secret-token-value-1234")
  })

  test("get with reveal returns the raw value", async () => {
    const got = await callVariable(client, {
      action: "get",
      name: "ADMIN_JWT",
      reveal: true,
    })
    expect(got.value).toBe("secret-token-value-1234")
  })

  test("delete removes the variable", async () => {
    expect((await callVariable(client, { action: "delete", name: "ADMIN_JWT" })).deleted).toBe(true)
    expect((await callVariable(client, { action: "get", name: "ADMIN_JWT" })).error).toContain("no variable")
  })

  test("get of a missing variable is a clean error, and set validates inputs", async () => {
    expect((await callVariable(client, { action: "get", name: "NOPE" })).error).toContain("no variable")
    expect((await callVariable(client, { action: "set", name: "X" })).error).toContain("value")

    const rejected = await client.callTool({
      name: "variable",
      arguments: {
        action: "set",
        name: "CORRUPTED_CAPTURE",
        value: "https://[redacted:variable:scope_assets]/app#signed-init-data",
      },
    })
    expect(rejected.isError).toBe(true)
    expect(jsonContent(rejected).error).toContain("redaction marker")

    const row = Database.use((db: import("../../storage/db").TxOrDb) =>
      db
        .select()
        .from(SessionVariableTable)
        .where(and(eq(SessionVariableTable.session_id, SESSION), eq(SessionVariableTable.name, "CORRUPTED_CAPTURE")))
        .get(),
    )
    expect(row).toBeUndefined()
  })

  test("reserved host state cannot be listed, read, changed, or deleted through MCP", async () => {
    Database.use((db: import("../../storage/db").TxOrDb) =>
      db
        .insert(SessionVariableTable)
        .values({
          session_id: SESSION,
          name: "_cyberful_host_test_secret",
          source_message_id: null,
          description: "test",
          value: "host-secret-value",
        })
        .run(),
    )
    const list = await callVariable(client, { action: "list" })
    expect(recordArray(list.variables, "listed variables").map((item) => item.name)).not.toContain(
      "_cyberful_host_test_secret",
    )
    for (const action of ["get", "set", "delete"] as const) {
      const result = await callVariable(client, {
        action,
        name: "_cyberful_host_test_secret",
        ...(action === "set" ? { value: "replacement" } : {}),
      })
      expect(result.error).toContain("host-owned")
    }
    const row = Database.use((db: import("../../storage/db").TxOrDb) =>
      db
        .select()
        .from(SessionVariableTable)
        .where(
          and(
            eq(SessionVariableTable.session_id, SESSION),
            eq(SessionVariableTable.name, "_cyberful_host_test_secret"),
          ),
        )
        .get(),
    )
    expect(row?.value).toBe("host-secret-value")
  })
})

describe("expert-gateway workflow capability policy", () => {
  test("keeps Code Audit offline while live-target workflows own target traffic", () => {
    expect(
      runtimeCapabilityAllowed({
        workflow: "code-audit",
        phase: "attack",
        capability: "browser",
        authorized: true,
      }),
    ).toBe(false)
    expect(
      runtimeCapabilityAllowed({
        workflow: "code-audit",
        phase: "scope",
        capability: "audit-diff",
        authorized: false,
      }),
    ).toBe(true)
    expect(
      runtimeCapabilityAllowed({ workflow: "pentest", phase: "recon", capability: "browser", authorized: false }),
    ).toBe(true)
    expect(
      runtimeCapabilityAllowed({
        workflow: "bug-bounty",
        phase: "recon",
        capability: "browser",
        authorized: false,
      }),
    ).toBe(true)
    expect(
      runtimeCapabilityAllowed({ workflow: "unknown", phase: "test", capability: "browser", authorized: true }),
    ).toBe(false)
    expect(runtimeNetworkAllowed({ workflow: "code-audit", phase: "attack", authorized: true })).toBe(false)
    expect(runtimeNetworkAllowed({ workflow: "pentest", phase: "recon", authorized: false })).toBe(true)
    expect(runtimeNetworkAllowed({ workflow: "bug-bounty", phase: "recon", authorized: false })).toBe(true)
    expect(runtimeNetworkAllowed({ workflow: "ask", phase: "ask", authorized: false })).toBe(true)
  })

  test("publishes source and lab tools only to eligible workflow phases", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "expert-gateway-workflow-tools-"))
    const source = path.join(directory, "source")
    const workarea = path.join(directory, "workarea")
    const sourceStore = path.join(directory, "source-store")
    await Promise.all([mkdir(source), mkdir(workarea), mkdir(path.join(sourceStore, "import"), { recursive: true })])
    const previous = {
      workflow: process.env.CYBERFUL_SUBSYSTEM_WORKFLOW,
      phase: process.env.CYBERFUL_SUBSYSTEM_PHASE,
      source: process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT,
      workarea: process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT,
      sourceStore: process.env.CYBERFUL_SOURCE_STORE_ROOT,
      novelty: process.env.CYBERFUL_SUBSYSTEM_NOVELTY_CONTRACT,
      evmRuntime: process.env.CYBERFUL_EVM_RUNTIME_ID,
    }
    process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT = source
    process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = workarea
    process.env.CYBERFUL_SOURCE_STORE_ROOT = sourceStore
    process.env.CYBERFUL_EVM_RUNTIME_ID = "11111111-2222-4333-8444-555555555555"

    async function toolNames(workflow: string, phase: string) {
      process.env.CYBERFUL_SUBSYSTEM_WORKFLOW = workflow
      process.env.CYBERFUL_SUBSYSTEM_PHASE = phase
      const scoped = await createGatewayServer({ upstreams: [] })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await scoped.connect(serverTransport)
      const workflowClient = new Client({ name: `${workflow}-tools-test`, version: "0" })
      await workflowClient.connect(clientTransport)
      try {
        return (await workflowClient.listTools()).tools.map((tool) => tool.name)
      } finally {
        await workflowClient.close()
        await scoped.closeGateway()
      }
    }

    try {
      const audit = await toolNames("code-audit", "scope")
      expect(audit).toContain("source_inventory")
      expect(audit).toContain("source_import")
      expect(audit).toContain("code_graph_index")
      expect(audit).toContain("audit_diff_prepare")
      expect(audit).not.toContain("audit_lab_prepare")
      const index = await toolNames("code-audit", "index")
      expect(index).not.toContain("source_import")
      expect(index).not.toContain("audit_diff_prepare")
      expect(index).not.toContain("audit_lab_prepare")
      const attack = await toolNames("code-audit", "attack")
      expect(attack).toContain("source_read")
      expect(attack).toContain("code_finding")
      expect(attack).toContain("audit_lab_prepare")
      expect(attack).toContain("hypothesis")
      expect(await toolNames("code-audit", "missing")).toEqual(["variable"])
      expect(await toolNames("unknown", "brief")).toEqual(["variable"])

      expect(await toolNames("pentest", "recon")).toEqual([
        "variable",
        "test_object",
        "egress_observation",
        "hypothesis",
      ])
      process.env.CYBERFUL_SUBSYSTEM_NOVELTY_CONTRACT = JSON.stringify({ required: true })
      expect(await toolNames("bug-bounty", "recon")).toEqual([
        "variable",
        "source_import",
        "source_catalog",
        "source_inventory",
        "source_read",
        "source_search",
        "source_snapshot",
        "evm_lab",
        "evm_evidence",
        "test_object",
        "egress_observation",
        "hypothesis",
      ])
      expect(await toolNames("bug-bounty", "brief")).toEqual([
        "variable",
        "source_import",
        "source_catalog",
        "source_inventory",
        "source_read",
        "source_search",
        "source_snapshot",
        "hypothesis",
        "engagement_policy",
      ])
      expect(await toolNames("bug-bounty", "report")).toEqual([
        "variable",
        "source_catalog",
        "source_inventory",
        "source_read",
        "source_search",
        "source_snapshot",
        "evm_evidence",
        "hypothesis",
      ])
    } finally {
      if (previous.workflow === undefined) delete process.env.CYBERFUL_SUBSYSTEM_WORKFLOW
      else process.env.CYBERFUL_SUBSYSTEM_WORKFLOW = previous.workflow
      if (previous.phase === undefined) delete process.env.CYBERFUL_SUBSYSTEM_PHASE
      else process.env.CYBERFUL_SUBSYSTEM_PHASE = previous.phase
      if (previous.source === undefined) delete process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT
      else process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT = previous.source
      if (previous.workarea === undefined) delete process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT
      else process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = previous.workarea
      if (previous.sourceStore === undefined) delete process.env.CYBERFUL_SOURCE_STORE_ROOT
      else process.env.CYBERFUL_SOURCE_STORE_ROOT = previous.sourceStore
      if (previous.novelty === undefined) delete process.env.CYBERFUL_SUBSYSTEM_NOVELTY_CONTRACT
      else process.env.CYBERFUL_SUBSYSTEM_NOVELTY_CONTRACT = previous.novelty
      if (previous.evmRuntime === undefined) delete process.env.CYBERFUL_EVM_RUNTIME_ID
      else process.env.CYBERFUL_EVM_RUNTIME_ID = previous.evmRuntime
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("expert-gateway cyberful-os/browser proxy", () => {
  test("registers its PID once at startup", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "expert-gateway-pid-test-"))
    const signal = path.join(dir, "gateway-pid.json")
    try {
      await writeGatewayPidSignal(signal, 4242)
      expect(JSON.parse(await readFile(signal, "utf8"))).toEqual({ pid: 4242 })
      await expect(writeGatewayPidSignal(signal, 4243)).rejects.toThrow()
      await expect(writeGatewayPidSignal("relative.json", 4242)).rejects.toThrow("must be absolute")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("lets a delegated child gateway join the validated root PID claim without replacing it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "expert-gateway-child-pid-test-"))
    const signal = path.join(dir, "gateway-pid.json")
    try {
      expect(await claimGatewayPidSignal(signal, process.pid)).toEqual({ owner: true, pid: process.pid })
      expect(await claimGatewayPidSignal(signal, process.pid + 1)).toEqual({ owner: false, pid: process.pid })
      expect(JSON.parse(await readFile(signal, "utf8"))).toEqual({ pid: process.pid })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("detects a gateway whose original worker parent disappeared or changed", () => {
    // The test runner's parent may exit independently; this process is the stable live PID we own.
    expect(parentUnavailable(process.pid, process.pid)).toBe(false)
    expect(parentUnavailable(process.pid, 1)).toBe(true)
    expect(parentUnavailable(2_147_483_647, 2_147_483_647)).toBe(true)
  })

  test("closing the gateway closes its upstream clients exactly once", async () => {
    let closes = 0
    const server = await createGatewayServer({
      upstreams: [],
      closeUpstreams: async () => {
        closes += 1
      },
    })
    await server.closeGateway()
    await server.closeGateway()
    expect(closes).toBe(1)
  })

  test("re-exposes upstream tools, resolves simple and composed {{var}} args, and redacts replies", async () => {
    // A fake upstream stands in for cyberful-os/browser: it records the args it received (to prove the
    // gateway resolved the template before forwarding) and echoes them back (to prove the gateway
    // redacts secret values out of the reply).
    let received: Record<string, unknown> | undefined
    const echo: UpstreamTool = {
      def: {
        name: "echo",
        description: "echo",
        inputSchema: { type: "object", properties: { u: { type: "string" } } },
      },
      call: async (args) => {
        received = args
        return { content: [{ type: "text", text: `fetched ${String(args.u)}` }] }
      },
    }
    const server = await createGatewayServer({ upstreams: [echo] })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const c = new Client({ name: "proxy-test", version: "0" })
    await c.connect(ct)
    try {
      // The gateway advertises its own variable tool AND the proxied upstream tool.
      const { tools } = await c.listTools()
      expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "variable"])

      await callVariable(c, { action: "set", name: "TARGET", value: "https://target.example/admin" })
      const res = await c.callTool({ name: "echo", arguments: { u: "{{var:TARGET}}" } })

      // The upstream received the RESOLVED value (auto-rewrite); the reply came back with that value
      // REDACTED so it does not re-enter the Expert's context.
      expect(received?.u).toBe("https://target.example/admin")
      expect(textContent(res)).toContain("[redacted:variable:TARGET]")
      expect(textContent(res)).not.toContain("target.example")

      // Exercise the real gateway/store boundary for the browser-marker regression, not just the pure
      // resolver unit. The upstream must never see the inner template that was persisted in MARKER.
      await callVariable(c, { action: "set", name: "MARKER_PREFIX", value: "cyberful-browser-" })
      await callVariable(c, {
        action: "set",
        name: "MARKER",
        value: "{{var:MARKER_PREFIX}}20260715T153737785Z",
      })
      await c.callTool({ name: "echo", arguments: { u: "https://example.com/?{{var:MARKER}}" } })
      expect(received?.u).toBe("https://example.com/?cyberful-browser-20260715T153737785Z")
    } finally {
      await c.close()
      await server.closeGateway()
    }
  })

  test("advertises one browser tool and routes calls to isolated numbered profiles", async () => {
    const calls: { profile: number; args: Record<string, unknown> }[] = []
    const browserTool = (profile: 1 | 2): UpstreamTool => ({
      def: {
        name: "browser_navigate",
        description: "Open a URL.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
      capability: "browser",
      browserProfile: profile,
      call: async (args) => {
        calls.push({ profile, args })
        return { content: [{ type: "text", text: JSON.stringify({ profile }) }] }
      },
    })
    const server = await createGatewayServer({ upstreams: [browserTool(1), browserTool(2)] })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const browserClient = new Client({ name: "browser-profile-test", version: "0" })
    await browserClient.connect(clientTransport)
    try {
      const browserDefinitions = (await browserClient.listTools()).tools.filter(
        (tool) => tool.name === "browser_navigate",
      )
      expect(browserDefinitions).toHaveLength(1)
      expect(browserDefinitions[0]?.inputSchema).toMatchObject({
        properties: { profile: { type: "integer", enum: [1, 2], default: 1 } },
      })

      const explicit = await browserClient.callTool({
        name: "browser_navigate",
        arguments: { profile: 2, url: "https://example.test/account" },
      })
      const defaulted = await browserClient.callTool({
        name: "browser_navigate",
        arguments: { url: "https://example.test/default" },
      })
      expect(calls).toEqual([
        { profile: 2, args: { url: "https://example.test/account" } },
        { profile: 1, args: { url: "https://example.test/default" } },
      ])
      expect(explicit._meta).toMatchObject({ cyberful: { browserProfile: 2 } })
      expect(defaulted._meta).toMatchObject({ cyberful: { browserProfile: 1 } })
    } finally {
      await browserClient.close()
      await server.closeGateway()
    }
  })

  test("filters injected Brief upstreams to local shell and ordinary browser preflight", async () => {
    const previous = {
      workflow: process.env.CYBERFUL_SUBSYSTEM_WORKFLOW,
      phase: process.env.CYBERFUL_SUBSYSTEM_PHASE,
      workarea: process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT,
    }
    process.env.CYBERFUL_SUBSYSTEM_WORKFLOW = "pentest"
    process.env.CYBERFUL_SUBSYSTEM_PHASE = "brief"
    process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = "/tmp"
    const upstream = (
      name: string,
      capability: UpstreamTool["capability"],
    ): UpstreamTool => ({
      def: { name, inputSchema: { type: "object", properties: {} } },
      capability,
      call: async () => ({ content: [{ type: "text", text: "unused" }] }),
    })
    const server = await createGatewayServer({
      upstreams: [
        upstream("shell", "isolated-exec"),
        upstream("nmap", "isolated-exec"),
        upstream("browser_navigate", "browser"),
        upstream("browser_evaluate", "browser"),
        upstream("zap_history", "zap"),
      ],
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const briefClient = new Client({ name: "brief-tool-policy-test", version: "0" })
    await briefClient.connect(clientTransport)
    try {
      const names = (await briefClient.listTools()).tools.map((tool) => tool.name)
      expect(names).toContain("shell")
      expect(names).toContain("browser_navigate")
      expect(names).not.toContain("nmap")
      expect(names).not.toContain("browser_evaluate")
      expect(names).not.toContain("zap_history")
    } finally {
      await briefClient.close()
      await server.closeGateway()
      if (previous.workflow === undefined) delete process.env.CYBERFUL_SUBSYSTEM_WORKFLOW
      else process.env.CYBERFUL_SUBSYSTEM_WORKFLOW = previous.workflow
      if (previous.phase === undefined) delete process.env.CYBERFUL_SUBSYSTEM_PHASE
      else process.env.CYBERFUL_SUBSYSTEM_PHASE = previous.phase
      if (previous.workarea === undefined) delete process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT
      else process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = previous.workarea
    }
  })

  test("applies the advertised max_output_bytes ceiling once before an upstream executes", async () => {
    let received: Record<string, unknown> | undefined
    const bounded: UpstreamTool = {
      def: {
        name: "bounded_output",
        description: "bounded output probe",
        inputSchema: {
          type: "object",
          properties: { max_output_bytes: { type: "integer", minimum: 1024, maximum: 4_194_304 } },
        },
      },
      call: async (args) => {
        received = args
        return { content: [{ type: "text", text: "executed once" }] }
      },
    }
    const server = await createGatewayServer({ upstreams: [bounded] })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const boundedClient = new Client({ name: "bounded-output-test", version: "0" })
    await boundedClient.connect(clientTransport)
    try {
      const result = await boundedClient.callTool({
        name: "bounded_output",
        arguments: { max_output_bytes: 8_388_608 },
      })
      expect(received?.max_output_bytes).toBe(4_194_304)
      expect(textContent(result)).toContain("reduced from 8388608 to 4194304")
      const meta = recordValue(result._meta, "adjusted tool metadata")
      const cyberful = recordValue(meta.cyberful, "Cyberful adjustment metadata")
      expect(cyberful.adjustments).toEqual([
        {
          field: "max_output_bytes",
          requested: 8_388_608,
          applied: 4_194_304,
          reason: "declared-maximum",
        },
      ])
    } finally {
      await boundedClient.close()
      await server.closeGateway()
    }
  })

  test("forwards exposed material scanner calls", async () => {
    let calls = 0
    const nmap: UpstreamTool = {
      def: { name: "nmap", description: "scanner", inputSchema: { type: "object" } },
      call: async () => {
        calls++
        return { content: [{ type: "text", text: "done" }] }
      },
    }
    const server = await createGatewayServer({ upstreams: [nmap] })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const scannerClient = new Client({ name: "scanner-forwarding-test", version: "0" })
    await scannerClient.connect(clientTransport)
    try {
      const result = await scannerClient.callTool({ name: "nmap", arguments: { args: ["example.com"] } })
      expect("isError" in result && result.isError).not.toBe(true)
      expect(calls).toBe(1)
    } finally {
      await scannerClient.close()
      await server.closeGateway()
    }
  })

  test("forwards ZAP report tools in every phase without a Cyberful phase gate", async () => {
    for (const phase of ["recon", "report"]) {
      const calls: string[] = []
      const previous = process.env.CYBERFUL_SUBSYSTEM_PHASE
      process.env.CYBERFUL_SUBSYSTEM_PHASE = phase
      const server = await createGatewayServer({
        upstreams: ["zap_generate_report", "zap_generate_workarea_report"].map((name) => ({
          def: { name, description: name, inputSchema: { type: "object" } },
          call: async () => {
            calls.push(name)
            return { content: [{ type: "text" as const, text: name }] }
          },
        })),
      })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const phaseClient = new Client({ name: `zap-${phase}-autonomy-test`, version: "0" })
      await phaseClient.connect(clientTransport)
      try {
        for (const name of ["zap_generate_report", "zap_generate_workarea_report"]) {
          const result = await phaseClient.callTool({ name, arguments: {} })
          expect("isError" in result && result.isError).not.toBe(true)
        }
        expect(calls).toEqual(["zap_generate_report", "zap_generate_workarea_report"])
      } finally {
        await phaseClient.close()
        await server.closeGateway()
        if (previous === undefined) delete process.env.CYBERFUL_SUBSYSTEM_PHASE
        else process.env.CYBERFUL_SUBSYSTEM_PHASE = previous
      }
    }
  })

  test("forwards upstream resources, templates, and prompts without renaming them", async () => {
    const upstreamServer = new Server(
      { name: "zap-test", version: "0" },
      { capabilities: { resources: {}, prompts: {} } },
    )
    upstreamServer.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{ uri: "zap://alerts", name: "ZAP alerts" }],
    }))
    upstreamServer.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: [{ uriTemplate: "zap://history/{id}", name: "ZAP history item" }],
    }))
    upstreamServer.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
      contents: [{ uri: request.params.uri, text: "captured secret-token-value-1234" }],
    }))
    upstreamServer.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [{ name: "zap_full_scan", description: "Full ZAP scan" }],
    }))
    upstreamServer.setRequestHandler(GetPromptRequestSchema, async (request) => ({
      messages: [{ role: "user", content: { type: "text", text: `scan ${request.params.arguments?.target}` } }],
    }))

    const [upstreamClientTransport, upstreamServerTransport] = InMemoryTransport.createLinkedPair()
    await upstreamServer.connect(upstreamServerTransport)
    const upstreamClient = new Client({ name: "gateway-upstream-test", version: "0" })
    await upstreamClient.connect(upstreamClientTransport)

    const server = await createGatewayServer({
      upstreams: [],
      upstreamClients: [upstreamClient],
      closeUpstreams: () => upstreamClient.close(),
    })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const c = new Client({ name: "gateway-surface-test", version: "0" })
    await c.connect(ct)
    try {
      await callVariable(c, { action: "set", name: "TOKEN", value: "secret-token-value-1234" })
      expect((await c.listResources()).resources.map((item) => item.uri)).toEqual(["zap://alerts"])
      expect((await c.listResourceTemplates()).resourceTemplates.map((item) => item.uriTemplate)).toEqual([
        "zap://history/{id}",
      ])
      const resource = await c.readResource({ uri: "zap://history/42" })
      expect(resource.contents[0]).toEqual({ uri: "zap://history/42", text: "captured [redacted:variable:TOKEN]" })
      expect((await c.listPrompts()).prompts.map((item) => item.name)).toEqual(["zap_full_scan"])
      expect(await c.getPrompt({ name: "zap_full_scan", arguments: { target: "{{var:TOKEN}}" } })).toEqual({
        messages: [{ role: "user", content: { type: "text", text: "scan [redacted:variable:TOKEN]" } }],
      })
    } finally {
      await c.close()
      await server.closeGateway()
      await upstreamServer.close()
    }
  })
})

describe("expert-gateway handoff tool", () => {
  test("commits Brief policy only after ZAP enforcement and blocks handoff after a failed install", async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "expert-policy-enforcement-test-")))
    const signal = path.join(dir, "handoff.json")
    const policyPath = path.join(dir, "raw", "policy", "engagement.json")
    const environment = [
      "CYBERFUL_SUBSYSTEM_PHASE",
      "CYBERFUL_SUBSYSTEM_WORKFLOW",
      "CYBERFUL_SUBSYSTEM_WORKAREA_ROOT",
      "CYBERFUL_SUBSYSTEM_HANDOFF_PATH",
      "CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR",
      "CYBERFUL_SUBSYSTEM_HANDOFF_TERMINAL",
      "CYBERFUL_SUBSYSTEM_HANDOFF_ARTIFACT",
      "CYBER_ZAP_PROXY_URL",
      "CYBER_ZAP_API_KEY",
    ] as const
    const previous = Object.fromEntries(environment.map((key) => [key, process.env[key]]))
    Object.assign(process.env, {
      CYBERFUL_SUBSYSTEM_PHASE: "brief",
      CYBERFUL_SUBSYSTEM_WORKFLOW: "bug-bounty",
      CYBERFUL_SUBSYSTEM_WORKAREA_ROOT: dir,
      CYBERFUL_SUBSYSTEM_HANDOFF_PATH: signal,
      CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR: "recon",
      CYBERFUL_SUBSYSTEM_HANDOFF_ARTIFACT: "MISSION.md",
      CYBER_ZAP_PROXY_URL: "http://127.0.0.1:49152",
      CYBER_ZAP_API_KEY: "private-gateway-test-key",
    })
    delete process.env.CYBERFUL_SUBSYSTEM_HANDOFF_TERMINAL
    await writeFile(path.join(dir, "MISSION.md"), "# Mission\n")
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "internal_error", message: "local ZAP action failed" }), {
        status: 502,
      }),
    )
    let server: Awaited<ReturnType<typeof createGatewayServer>> | undefined
    let c: McpClient | undefined
    try {
      server = await createGatewayServer({ upstreams: [] })
      const [ct, st] = InMemoryTransport.createLinkedPair()
      await server.connect(st)
      c = new Client({ name: "policy-enforcement-test", version: "0" })
      await c.connect(ct)
      const arguments_ = {
        action: "set",
        profiles: [],
        authorized_http_hosts: ["app.example.test"],
        global_http_rps: 4,
      }

      const failed = await c.callTool({ name: "engagement_policy", arguments: arguments_ })
      expect(failed.isError).toBe(true)
      expect(jsonContent(failed)).toMatchObject({
        code: "zap_rate_limit_install_failed",
        retryable: false,
        user_action_required: false,
        policy_stored: false,
      })
      await expect(readFile(policyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })

      const blocked = await c.callTool({
        name: "handoff",
        arguments: { summary: "brief recorded", artifact: "MISSION.md", target: "recon" },
      })
      expect(blocked.isError).toBe(true)
      expect(errorContent(blocked).message).toContain("engagement_policy")

      fetch.mockResolvedValue(new Response('{"Result":"OK"}', { status: 200 }))
      const installed = await c.callTool({ name: "engagement_policy", arguments: arguments_ })
      expect(installed.isError).not.toBe(true)
      expect(jsonContent(installed)).toMatchObject({
        policy: { authorized_http_hosts: ["app.example.test"], global_http_rps: 4 },
        enforcement: { configured: true, requests_per_second: 4, group_by: "rule" },
      })
      expect(JSON.parse(await readFile(policyPath, "utf8"))).toMatchObject({
        authorized_http_hosts: ["app.example.test"],
        global_http_rps: 4,
      })

      const accepted = await c.callTool({
        name: "handoff",
        arguments: { summary: "brief recorded", artifact: "MISSION.md", target: "recon" },
      })
      expect(accepted.isError).not.toBe(true)
      expect(jsonContent(accepted).successor).toBe("recon")
    } finally {
      fetch.mockRestore()
      await c?.close()
      await server?.closeGateway()
      for (const key of environment) {
        const value = previous[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("records only the configured forward transition for the parent runner", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "expert-handoff-test-"))
    const signal = path.join(dir, "handoff.json")
    const previous = {
      phase: process.env.CYBERFUL_SUBSYSTEM_PHASE,
      path: process.env.CYBERFUL_SUBSYSTEM_HANDOFF_PATH,
      successor: process.env.CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR,
      terminal: process.env.CYBERFUL_SUBSYSTEM_HANDOFF_TERMINAL,
      workarea: process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT,
      artifact: process.env.CYBERFUL_SUBSYSTEM_HANDOFF_ARTIFACT,
    }
    process.env.CYBERFUL_SUBSYSTEM_PHASE = "exploit"
    process.env.CYBERFUL_SUBSYSTEM_HANDOFF_PATH = signal
    process.env.CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR = "hacker"
    process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = dir
    process.env.CYBERFUL_SUBSYSTEM_HANDOFF_ARTIFACT = "EXPLOIT.md"
    delete process.env.CYBERFUL_SUBSYSTEM_HANDOFF_TERMINAL
    let server: Awaited<ReturnType<typeof createGatewayServer>> | undefined
    let c: McpClient | undefined
    try {
      server = await createGatewayServer({ upstreams: [] })
      const [ct, st] = InMemoryTransport.createLinkedPair()
      await server.connect(st)
      c = new Client({ name: "handoff-test", version: "0" })
      await c.connect(ct)
      const { tools } = await c.listTools()
      expect(tools.map((tool) => tool.name).sort()).toEqual(["handoff", "variable"])

      const refused = await c.callTool({
        name: "handoff",
        arguments: { summary: "done", artifact: "EXPLOIT.md", target: "report" },
      })
      expect(errorContent(refused).message).toContain("not allowed")
      expect(errorContent(refused)).toMatchObject({
        code: "HANDOFF_TARGET_INVALID",
        path: "target",
        expected: "hacker",
        receivedType: "string",
        retryable: true,
        hint: expect.any(String),
      })

      await mkdir(path.join(dir, "work", "anthropic"), { recursive: true })
      await writeFile(path.join(dir, "work", "anthropic", "EXPLOIT.md"), "wrong nested copy")
      const wrongPath = await c.callTool({
        name: "handoff",
        arguments: {
          summary: "confirmed one issue",
          artifact: "EXPLOIT.md",
          completion: {
            title: "Pentest completed",
            summaryMarkdown: "One confirmed issue.",
            artifacts: [{ label: "Evidence", path: "evidence/issue.txt" }],
          },
        },
      })
      expect(errorContent(wrongPath).message).toContain("missing from the workarea root")
      expect(errorContent(wrongPath).hint).toContain("/workspace/EXPLOIT.md")
      await writeFile(path.join(dir, "EXPLOIT.md"), "root deliverable")
      const accepted = await c.callTool({
        name: "handoff",
        arguments: {
          summary: "confirmed one issue",
          artifact: "EXPLOIT.md",
          completion: {
            title: "Pentest completed",
            summaryMarkdown: "One confirmed issue.",
            artifacts: [{ label: "Evidence", path: "evidence/issue.txt" }],
          },
        },
      })
      expect(jsonContent(accepted).successor).toBe("hacker")
      const duplicate = await c.callTool({
        name: "handoff",
        arguments: { summary: "second attempt", artifact: "EXPLOIT.md" },
      })
      expect(errorContent(duplicate).message).toContain("already recorded")
      expect(JSON.parse(await readFile(signal, "utf8"))).toEqual(
        expect.objectContaining({
          phase: "exploit",
          successor: "hacker",
          summary: "confirmed one issue",
          artifact: "EXPLOIT.md",
          completion: {
            title: "Pentest completed",
            summaryMarkdown: "One confirmed issue.",
            artifacts: [{ label: "Evidence", path: "evidence/issue.txt" }],
          },
        }),
      )
    } finally {
      await c?.close()
      await server?.closeGateway()
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      restore("CYBERFUL_SUBSYSTEM_PHASE", previous.phase)
      restore("CYBERFUL_SUBSYSTEM_HANDOFF_PATH", previous.path)
      restore("CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR", previous.successor)
      restore("CYBERFUL_SUBSYSTEM_HANDOFF_TERMINAL", previous.terminal)
      restore("CYBERFUL_SUBSYSTEM_WORKAREA_ROOT", previous.workarea)
      restore("CYBERFUL_SUBSYSTEM_HANDOFF_ARTIFACT", previous.artifact)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("derives structured UNTESTABLE blockers from the Bug Bounty hypothesis registry", async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "expert-bounty-verdict-test-")))
    const signal = path.join(dir, "handoff.json")
    const previous = {
      phase: process.env.CYBERFUL_SUBSYSTEM_PHASE,
      workflow: process.env.CYBERFUL_SUBSYSTEM_WORKFLOW,
      workarea: process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT,
      handoff: process.env.CYBERFUL_SUBSYSTEM_HANDOFF_PATH,
      successor: process.env.CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR,
    }
    Object.assign(process.env, {
      CYBERFUL_SUBSYSTEM_PHASE: "exploit",
      CYBERFUL_SUBSYSTEM_WORKFLOW: "bug-bounty",
      CYBERFUL_SUBSYSTEM_WORKAREA_ROOT: dir,
      CYBERFUL_SUBSYSTEM_HANDOFF_PATH: signal,
      CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR: "hacker",
    })
    let server: Awaited<ReturnType<typeof createGatewayServer>> | undefined
    let c: McpClient | undefined
    try {
      server = await createGatewayServer({ upstreams: [] })
      const [ct, st] = InMemoryTransport.createLinkedPair()
      await server.connect(st)
      c = new Client({ name: "bounty-verdict-test", version: "0" })
      await c.connect(ct)
      await c.callTool({
        name: "hypothesis",
        arguments: {
          action: "record",
          id: "B3",
          owner: "exploit-root",
          description: "First-party configuration may expose adjacent tenant state",
          root_cause: "missing ownership check",
          surface: "configuration API",
          discriminator: "tenant-specific response differential",
        },
      })
      await c.callTool({
        name: "hypothesis",
        arguments: {
          action: "update",
          id: "B3",
          state: "UNTESTABLE",
          blocker: "The intended first-party configuration was not supplied.",
          blocker_reason: "MISSING_PREREQUISITE",
          next_step: "Capture the intended first-party configuration flow.",
          reason: "The required first-party configuration was unavailable in this phase.",
        },
      })
      const accepted = await c.callTool({
        name: "handoff",
        arguments: { summary: "one hypothesis could not run", artifact: "EXPLOIT.md" },
      })
      expect(jsonContent(accepted).successor).toBe("hacker")
      expect(JSON.parse(await readFile(signal, "utf8"))).toMatchObject({
        snapshot: {
          version: 2,
          counts: {
            hypotheses: { UNTESTABLE: 1 },
            findings: { CONFIRMED: 0, SUSPECTED: 0 },
          },
        },
      })
    } finally {
      await c?.close()
      await server?.closeGateway()
      for (const [key, value] of Object.entries(previous)) {
        const environment =
          key === "phase"
            ? "CYBERFUL_SUBSYSTEM_PHASE"
            : key === "workflow"
              ? "CYBERFUL_SUBSYSTEM_WORKFLOW"
              : key === "workarea"
                ? "CYBERFUL_SUBSYSTEM_WORKAREA_ROOT"
                : key === "handoff"
                  ? "CYBERFUL_SUBSYSTEM_HANDOFF_PATH"
                  : "CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR"
        if (value === undefined) delete process.env[environment]
        else process.env[environment] = value
      }
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("gates Bug Bounty handoff on object disposition and hypothesis synthesis", async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "expert-bounty-novelty-gate-test-")))
    const signal = path.join(dir, "handoff.json")
    const environment = [
      "CYBERFUL_SUBSYSTEM_PHASE",
      "CYBERFUL_SUBSYSTEM_WORKFLOW",
      "CYBERFUL_SUBSYSTEM_WORKAREA_ROOT",
      "CYBERFUL_SUBSYSTEM_HANDOFF_PATH",
      "CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR",
      "CYBERFUL_SUBSYSTEM_HANDOFF_TERMINAL",
      "CYBERFUL_SUBSYSTEM_NOVELTY_CONTRACT",
    ] as const
    const previous = Object.fromEntries(environment.map((key) => [key, process.env[key]]))
    Object.assign(process.env, {
      CYBERFUL_SUBSYSTEM_PHASE: "recon",
      CYBERFUL_SUBSYSTEM_WORKFLOW: "bug-bounty",
      CYBERFUL_SUBSYSTEM_WORKAREA_ROOT: dir,
      CYBERFUL_SUBSYSTEM_HANDOFF_PATH: signal,
      CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR: "exploit",
      CYBERFUL_SUBSYSTEM_NOVELTY_CONTRACT: JSON.stringify({ required: true }),
    })
    delete process.env.CYBERFUL_SUBSYSTEM_HANDOFF_TERMINAL
    let server: Awaited<ReturnType<typeof createGatewayServer>> | undefined
    let c: McpClient | undefined
    try {
      server = await createGatewayServer({ upstreams: [] })
      const [ct, st] = InMemoryTransport.createLinkedPair()
      await server.connect(st)
      c = new Client({ name: "bounty-novelty-gate-test", version: "0" })
      await c.connect(ct)

      await c.callTool({
        name: "test_object",
        arguments: { action: "transition", id: "project-1", kind: "project", label: "fixture", state: "planned" },
      })
      const openObject = await c.callTool({
        name: "handoff",
        arguments: { summary: "recon complete", artifact: "RECON.md" },
      })
      expect(errorContent(openObject).message).toContain("test-object lifecycle")

      await c.callTool({
        name: "test_object",
        arguments: { action: "transition", id: "project-1", state: "not_created" },
      })
      const missingNovelty = await c.callTool({
        name: "handoff",
        arguments: { summary: "recon complete", artifact: "RECON.md" },
      })
      expect(errorContent(missingNovelty).hint).toContain("phase synthesis")

      const synthesis = await c.callTool({
        name: "hypothesis",
        arguments: {
          action: "synthesize",
          outcome: "diversified",
          summary: "Checked an ownership seam outside the dominant endpoint family.",
          evidence: ["Compared creation and read enforcement across target-specific services."],
          remaining_unknowns: ["Asynchronous propagation semantics"],
        },
      })
      expect(jsonContent(synthesis).error).toBeUndefined()
      const accepted = await c.callTool({
        name: "handoff",
        arguments: { summary: "recon complete", artifact: "RECON.md" },
      })
      const acceptedContent = jsonContent(accepted)
      expect(acceptedContent.error).toBeUndefined()
      expect(acceptedContent.successor).toBe("exploit")
    } finally {
      await c?.close()
      await server?.closeGateway()
      for (const key of environment) {
        const value = previous[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("seals terminal AppSec findings into the fixed host-owned export before accepting handoff", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "expert-terminal-export-test-"))
    const source = path.join(dir, "source")
    const workarea = path.join(dir, "workarea")
    const sourceStore = path.join(dir, "source-store")
    const signal = path.join(dir, "handoff.json")
    await Promise.all([mkdir(source), mkdir(workarea), mkdir(path.join(sourceStore, "import"), { recursive: true })])
    const keys = [
      "CYBERFUL_SUBSYSTEM_WORKFLOW",
      "CYBERFUL_SUBSYSTEM_PHASE",
      "CYBERFUL_SUBSYSTEM_SOURCE_ROOT",
      "CYBERFUL_SUBSYSTEM_WORKAREA_ROOT",
      "CYBERFUL_SUBSYSTEM_HANDOFF_PATH",
      "CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR",
      "CYBERFUL_SUBSYSTEM_HANDOFF_TERMINAL",
      "CYBERFUL_CODE_GRAPH_LEDGER_KEY",
      "CYBERFUL_SOURCE_STORE_ROOT",
      "CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY",
    ] as const
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    Object.assign(process.env, {
      CYBERFUL_SUBSYSTEM_WORKFLOW: "code-audit",
      CYBERFUL_SUBSYSTEM_PHASE: "report",
      CYBERFUL_SUBSYSTEM_SOURCE_ROOT: source,
      CYBERFUL_SUBSYSTEM_WORKAREA_ROOT: workarea,
      CYBERFUL_SUBSYSTEM_HANDOFF_PATH: signal,
      CYBERFUL_SUBSYSTEM_HANDOFF_TERMINAL: "1",
      CYBERFUL_CODE_GRAPH_LEDGER_KEY: "terminal-export-test-key-with-at-least-32-bytes",
      CYBERFUL_SOURCE_STORE_ROOT: sourceStore,
      CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY: "terminal-export-import-key-with-at-least-32-bytes",
    })
    delete process.env.CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR
    let server: Awaited<ReturnType<typeof createGatewayServer>> | undefined
    let c: McpClient | undefined
    try {
      server = await createGatewayServer({ upstreams: [] })
      const [ct, st] = InMemoryTransport.createLinkedPair()
      await server.connect(st)
      c = new Client({ name: "terminal-export-test", version: "0" })
      await c.connect(ct)
      const accepted = await c.callTool({
        name: "handoff",
        arguments: { summary: "audit complete", artifact: "CODE_AUDIT_REPORT.md", target: "complete" },
      })
      expect(jsonContent(accepted).successor).toBe("complete")
      const sarif = recordValue(
        JSON.parse(await readFile(path.join(workarea, "reports", "code-audit.sarif"), "utf8")),
        "exported SARIF report",
      )
      expect(sarif.version).toBe("2.1.0")
      expect(sarif.runs).toHaveLength(1)
    } finally {
      await c?.close()
      await server?.closeGateway()
      for (const key of keys) {
        const value = previous[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("expert-gateway question tool", () => {
  async function questionClient(answer: (params: ElicitRequestFormParams) => ElicitResult | Promise<ElicitResult>) {
    const previous = process.env.CYBERFUL_SUBSYSTEM_QUESTION_ENABLED
    process.env.CYBERFUL_SUBSYSTEM_QUESTION_ENABLED = "1"
    let server: Awaited<ReturnType<typeof createGatewayServer>> | undefined
    let c: McpClient | undefined
    try {
      server = await createGatewayServer({ upstreams: [] })
      const [ct, st] = InMemoryTransport.createLinkedPair()
      await server.connect(st)
      c = new Client({ name: "question-test", version: "0" }, { capabilities: { elicitation: { form: {} } } })
      c.setRequestHandler(ElicitRequestSchema, async (request) => {
        if (request.params.mode === "url") throw new Error("question tool requested URL elicitation")
        return answer(request.params)
      })
      await c.connect(ct)
      return {
        client: c,
        close: async () => {
          await c?.close()
          await server?.closeGateway()
          if (previous === undefined) delete process.env.CYBERFUL_SUBSYSTEM_QUESTION_ENABLED
          else process.env.CYBERFUL_SUBSYSTEM_QUESTION_ENABLED = previous
        },
      }
    } catch (error) {
      await c?.close()
      await server?.closeGateway()
      if (previous === undefined) delete process.env.CYBERFUL_SUBSYSTEM_QUESTION_ENABLED
      else process.env.CYBERFUL_SUBSYSTEM_QUESTION_ENABLED = previous
      throw error
    }
  }

  test("uses native form elicitation and returns a single human answer", async () => {
    let observed: ElicitRequestFormParams | undefined
    const connected = await questionClient((params) => {
      observed = params
      return { action: "accept", content: { q0: JSON.stringify(["Proceed"]) } }
    })
    try {
      const c = connected.client
      const { tools } = await c.listTools()
      expect(tools.map((tool) => tool.name).sort()).toEqual(["question", "variable"])
      expect(tools.find((tool) => tool.name === "question")?.description).toContain(
        "each independent authority requires a separate call",
      )

      const result = await c.callTool({
        name: "question",
        arguments: {
          questions: [
            {
              header: "Authorization",
              question: "Proceed with the next active test?",
              options: [{ label: "Proceed", description: "Continue inside the agreed scope." }],
            },
          ],
        },
      })
      expect(jsonContent(result).answers).toEqual([
        { question: "Proceed with the next active test?", answers: ["Proceed"] },
      ])
      expect(observed?.mode).toBe("form")
      expect(observed?.requestedSchema.required).toEqual(["q0"])
      expect(isRecord(observed?._meta?.["cyberful.dev/approval"])).toBe(true)
    } finally {
      await connected.close()
    }
  })

  test("round-trips multi-select and custom answers", async () => {
    const connected = await questionClient(() => ({
      action: "accept",
      content: {
        q0: JSON.stringify(["API", "UI"]),
        q1: JSON.stringify(["A tester-controlled fixture"]),
      },
    }))
    try {
      const result = await connected.client.callTool({
        name: "question",
        arguments: {
          questions: [
            {
              header: "Surfaces",
              question: "Which surfaces should be exercised?",
              options: [
                { label: "API", description: "Exercise API paths." },
                { label: "UI", description: "Exercise UI paths." },
              ],
              multiple: true,
              custom: false,
            },
            {
              header: "Fixture",
              question: "Which temporary fixture should be created?",
              options: [{ label: "None", description: "Do not create a fixture." }],
            },
          ],
        },
      })
      expect(jsonContent(result).answers).toEqual([
        { question: "Which surfaces should be exercised?", answers: ["API", "UI"] },
        { question: "Which temporary fixture should be created?", answers: ["A tester-controlled fixture"] },
      ])
    } finally {
      await connected.close()
    }
  })

  for (const action of ["decline", "cancel"] as const) {
    test(`does not authorize work after elicitation ${action}`, async () => {
      const connected = await questionClient(() => ({ action }))
      try {
        const result = await connected.client.callTool({
          name: "question",
          arguments: {
            questions: [
              {
                header: "Authorization",
                question: "Proceed with the next active test?",
                options: [{ label: "Proceed", description: "Continue inside the agreed scope." }],
                custom: false,
              },
            ],
          },
        })
        expect(jsonContent(result)).toMatchObject({ ok: false, action })
        if (action === "decline")
          expect(jsonContent(result).output).toContain("before Cyberful received an explicit human decision")
      } finally {
        await connected.close()
      }
    })
  }

  test("attributes a decline to the human only with Cyberful decision metadata", async () => {
    const connected = await questionClient(() => ({ action: "decline", _meta: humanDecisionMetadata() }))
    try {
      const result = await connected.client.callTool({
        name: "question",
        arguments: {
          questions: [
            {
              header: "Authorization",
              question: "Proceed with the next active test?",
              options: [{ label: "Proceed", description: "Continue inside the agreed scope." }],
              custom: false,
            },
          ],
        },
      })
      expect(jsonContent(result).output).toContain("human explicitly declined")
    } finally {
      await connected.close()
    }
  })

  test("fails closed when accepted elicitation content is invalid", async () => {
    const connected = await questionClient(() => ({ action: "accept", content: { q0: "not-json" } }))
    try {
      const result = await connected.client.callTool({
        name: "question",
        arguments: {
          questions: [
            {
              header: "Authorization",
              question: "Proceed with the next active test?",
              options: [{ label: "Proceed", description: "Continue inside the agreed scope." }],
              custom: false,
            },
          ],
        },
      })
      expect(jsonContent(result).error).toContain("invalid answers")
      expect(result.isError).toBe(true)
    } finally {
      await connected.close()
    }
  })

  test("requires visible CAPTCHA attestation and pauses only its browser profile and origin", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "expert-captcha-gateway-test-"))
    const circuit = path.join(parent, "circuit.json")
    const previous = {
      question: process.env.CYBERFUL_SUBSYSTEM_QUESTION_ENABLED,
      circuit: process.env.CYBERFUL_SUBSYSTEM_CIRCUIT_BREAKER_PATH,
      phase: process.env.CYBERFUL_SUBSYSTEM_PHASE,
    }
    process.env.CYBERFUL_SUBSYSTEM_QUESTION_ENABLED = "1"
    process.env.CYBERFUL_SUBSYSTEM_CIRCUIT_BREAKER_PATH = circuit
    process.env.CYBERFUL_SUBSYSTEM_PHASE = "recon"
    let navigations = 0
    const browserMeta = (profile: number, pageID: string, origin: string, action: string) => ({
      "cyberful.dev/browser-action": {
        profile,
        page_id: pageID,
        origin,
        path_family: "/challenge",
        action,
        action_family: action.startsWith("browser_captcha") ? "captcha" : "navigation",
        page_transition: "none",
        outcome: "ok",
        status: 200,
      },
    })
    const upstreams: UpstreamTool[] = [
      {
        def: { name: "browser_captcha_handoff", inputSchema: { type: "object" } },
        call: async () => ({
          content: [{ type: "text", text: JSON.stringify({ detected: true, action: "manual_handoff_ready" }) }],
          _meta: browserMeta(1, "page-challenge", "https://example.test", "browser_captcha_handoff"),
        }),
        browserProfile: 1,
      },
      {
        def: { name: "browser_captcha_status", inputSchema: { type: "object" } },
        call: async () => ({
          content: [{ type: "text", text: JSON.stringify({ detected: false }) }],
          _meta: browserMeta(1, "page-challenge", "https://example.test", "browser_captcha_status"),
        }),
        browserProfile: 1,
      },
      ...([1, 2] as const).map(
        (profile): UpstreamTool => ({
          def: { name: "browser_navigate", inputSchema: { type: "object" } },
          call: async (args) => {
            navigations += 1
            const url = new URL(String(args.url))
            return {
              content: [{ type: "text", text: "navigated" }],
              _meta: browserMeta(profile, `page-${profile}`, url.origin, "browser_navigate"),
            }
          },
          browserProfile: profile,
        }),
      ),
    ]
    let server: Awaited<ReturnType<typeof createGatewayServer>> | undefined
    let c: McpClient | undefined
    let captchaAnswer = "No challenge visible"
    let replaceCaptchaBeforeAnswer = false
    try {
      server = await createGatewayServer({ upstreams })
      const [ct, st] = InMemoryTransport.createLinkedPair()
      await server.connect(st)
      c = new Client({ name: "captcha-test", version: "0" }, { capabilities: { elicitation: { form: {} } } })
      c.setRequestHandler(ElicitRequestSchema, async () => {
        if (replaceCaptchaBeforeAnswer) {
          replaceCaptchaBeforeAnswer = false
          await activateCircuitBreaker(
            circuit,
            "recon",
            { profile: 2, origin: "https://replacement.test", pageID: "page-replacement" },
            true,
          )
        }
        return {
          action: "accept",
          content: { q0: JSON.stringify([captchaAnswer]) },
        }
      })
      await c.connect(ct)
      const question = {
        kind: "captcha",
        questions: [
          {
            header: "CAPTCHA",
            question: "Solve the visible challenge, then continue.",
            options: [{ label: "Solved", description: "The challenge is complete." }],
          },
        ],
      }
      expect(jsonContent(await c.callTool({ name: "question", arguments: question })).error).toContain(
        "already visible",
      )
      await c.callTool({ name: "browser_captcha_handoff", arguments: { profile: 1 } })
      expect(
        jsonContent(
          await c.callTool({
            name: "browser_navigate",
            arguments: { profile: 1, url: "https://example.test/account" },
          }),
        ).error,
      ).toContain("human resolution")
      expect(navigations).toBe(0)
      expect(
        textContent(
          await c.callTool({
            name: "browser_navigate",
            arguments: { profile: 2, url: "https://example.test/account" },
          }),
        ),
      ).toBe("navigated")
      expect(
        textContent(
          await c.callTool({
            name: "browser_navigate",
            arguments: { profile: 1, url: "https://other.test/account" },
          }),
        ),
      ).toBe("navigated")
      expect(navigations).toBe(2)
      expect(jsonContent(await c.callTool({ name: "question", arguments: question })).output).toContain(
        "false-positive pause is cleared",
      )
      expect(
        textContent(
          await c.callTool({
            name: "browser_navigate",
            arguments: { profile: 1, url: "https://example.test/account" },
          }),
        ),
      ).toBe("navigated")
      expect(navigations).toBe(3)
      await c.callTool({ name: "browser_captcha_handoff", arguments: { profile: 1 } })
      captchaAnswer = "Resolved"
      await c.callTool({ name: "question", arguments: question })
      expect(
        jsonContent(
          await c.callTool({
            name: "browser_navigate",
            arguments: { profile: 1, url: "https://example.test/account" },
          }),
        ).error,
      ).toContain("human resolution")
      await c.callTool({ name: "browser_captcha_status", arguments: { profile: 1 } })
      expect(
        textContent(
          await c.callTool({
            name: "browser_navigate",
            arguments: { profile: 1, url: "https://example.test/account" },
          }),
        ),
      ).toBe("navigated")
      expect(navigations).toBe(4)
      await c.callTool({ name: "browser_captcha_handoff", arguments: { profile: 1 } })
      captchaAnswer = "No challenge visible"
      replaceCaptchaBeforeAnswer = true
      expect(jsonContent(await c.callTool({ name: "question", arguments: question })).output).toContain(
        "state changed before this answer arrived",
      )
      expect(await readCircuitBreaker(circuit)).toMatchObject({
        profile: 2,
        origin: "https://replacement.test",
        pageID: "page-replacement",
        status: "awaiting_human",
      })
    } finally {
      await c?.close()
      await server?.closeGateway()
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      restore("CYBERFUL_SUBSYSTEM_QUESTION_ENABLED", previous.question)
      restore("CYBERFUL_SUBSYSTEM_CIRCUIT_BREAKER_PATH", previous.circuit)
      restore("CYBERFUL_SUBSYSTEM_PHASE", previous.phase)
      await rm(parent, { recursive: true, force: true })
    }
  })
})
