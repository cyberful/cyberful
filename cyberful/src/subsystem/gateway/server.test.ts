// ── Phase Gateway Server Tests ────────────────────────────────────
// Verifies gateway scope, phase handoffs, tool policy, upstream proxying, question
// bridging, and local service cleanup through the real MCP server contract.
// → cyberful/src/subsystem/gateway/server.ts — owns the tested gateway lifecycle.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "fs/promises"
import os from "os"
import path from "path"
import { SessionID } from "../../session/schema"
import { ProjectID } from "../../project/schema"
import type { UpstreamTool } from "./server"
import { isRecord } from "@/util/record"

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
} = await import("@modelcontextprotocol/sdk/types.js")
const {
  claimGatewayPidSignal,
  createGatewayServer,
  parentUnavailable,
  runtimeCapabilityAllowed,
  runtimeNetworkAllowed,
  writeGatewayPidSignal,
} = await import("./server")
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
  test("exposes variable storage as the base tool surface", async () => {
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(["variable"])
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
  test("traffic-capable assessment and remediation phases require the recorded authorization", () => {
    expect(
      runtimeCapabilityAllowed({
        workflow: "assessment",
        phase: "test",
        capability: "browser",
        authorized: false,
      }),
    ).toBe(false)
    expect(
      runtimeCapabilityAllowed({
        workflow: "assessment",
        phase: "controls",
        capability: "zap",
        authorized: true,
      }),
    ).toBe(false)
    expect(
      runtimeCapabilityAllowed({
        workflow: "remediate",
        phase: "verify",
        capability: "zap",
        authorized: true,
      }),
    ).toBe(true)
    expect(
      runtimeCapabilityAllowed({ workflow: "pentest", phase: "recon", capability: "browser", authorized: false }),
    ).toBe(true)
    expect(
      runtimeCapabilityAllowed({ workflow: "unknown", phase: "test", capability: "browser", authorized: true }),
    ).toBe(false)
    expect(runtimeNetworkAllowed({ workflow: "code-audit", phase: "verify", authorized: true })).toBe(false)
    expect(runtimeNetworkAllowed({ workflow: "secure-review", phase: "audit", authorized: true })).toBe(false)
    expect(runtimeNetworkAllowed({ workflow: "assessment", phase: "controls", authorized: true })).toBe(false)
    expect(runtimeNetworkAllowed({ workflow: "assessment", phase: "test", authorized: true })).toBe(false)
    expect(runtimeNetworkAllowed({ workflow: "remediate", phase: "verify", authorized: true })).toBe(false)
    expect(runtimeNetworkAllowed({ workflow: "remediate", phase: "verify", authorized: false })).toBe(false)
    expect(runtimeNetworkAllowed({ workflow: "pentest", phase: "recon", authorized: false })).toBe(true)
  })

  test("publishes source and Git tools only to workflows that own them", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "expert-gateway-workflow-tools-"))
    const source = path.join(directory, "source")
    const workarea = path.join(directory, "workarea")
    await Promise.all([mkdir(source), mkdir(workarea)])
    const previous = {
      workflow: process.env.CYBERFUL_SUBSYSTEM_WORKFLOW,
      phase: process.env.CYBERFUL_SUBSYSTEM_PHASE,
      source: process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT,
      workarea: process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT,
    }
    process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT = source
    process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = workarea

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
      expect(audit).not.toContain("review_prepare")
      expect(audit).not.toContain("remediation_prepare")
      expect(await toolNames("code-audit", "index")).not.toContain("source_import")

      const review = await toolNames("secure-review", "map")
      expect(review).toContain("source_read")
      expect(review).toContain("source_import")
      expect(review).toContain("review_prepare")
      expect(review).not.toContain("remediation_publish")

      const remediate = await toolNames("remediate", "intake")
      expect(remediate).toContain("runtime_authorization")
      expect(remediate).toContain("source_import")
      expect(remediate).toContain("remediation_prepare")
      expect(remediate).toContain("remediation_publish")
      expect(remediate).not.toContain("review_prepare")

      const assessment = await toolNames("assessment", "brief")
      expect(assessment).toContain("runtime_authorization")
      expect(assessment).toContain("source_import")

      expect(await toolNames("assessment", "missing")).toEqual(["variable"])
      expect(await toolNames("unknown", "brief")).toEqual(["variable"])

      expect(await toolNames("pentest", "recon")).toEqual(["variable"])
    } finally {
      if (previous.workflow === undefined) delete process.env.CYBERFUL_SUBSYSTEM_WORKFLOW
      else process.env.CYBERFUL_SUBSYSTEM_WORKFLOW = previous.workflow
      if (previous.phase === undefined) delete process.env.CYBERFUL_SUBSYSTEM_PHASE
      else process.env.CYBERFUL_SUBSYSTEM_PHASE = previous.phase
      if (previous.source === undefined) delete process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT
      else process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT = previous.source
      if (previous.workarea === undefined) delete process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT
      else process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = previous.workarea
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

  test("lets a native child gateway join the validated root PID claim without replacing it", async () => {
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

  test("detects a gateway whose original CLI parent disappeared or changed", () => {
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

  test("keeps the official ZAP report tool visible but defers its call during Recon", async () => {
    let called = false
    const report: UpstreamTool = {
      def: { name: "zap_generate_report", description: "report", inputSchema: { type: "object" } },
      call: async () => {
        called = true
        return { content: [{ type: "text", text: "generated" }] }
      },
    }
    const previous = process.env.CYBERFUL_SUBSYSTEM_PHASE
    process.env.CYBERFUL_SUBSYSTEM_PHASE = "recon"
    const server = await createGatewayServer({ upstreams: [report] })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const reconClient = new Client({ name: "zap-recon-policy-test", version: "0" })
    await reconClient.connect(clientTransport)
    try {
      expect((await reconClient.listTools()).tools.map((tool) => tool.name)).toContain("zap_generate_report")
      const result = await reconClient.callTool({
        name: "zap_generate_report",
        arguments: { file_path: "early.json" },
      })
      expect("isError" in result && result.isError).toBe(true)
      expect(textContent(result)).toContain("after Recon completes")
      expect(called).toBe(false)
    } finally {
      await reconClient.close()
      await server.closeGateway()
      if (previous === undefined) delete process.env.CYBERFUL_SUBSYSTEM_PHASE
      else process.env.CYBERFUL_SUBSYSTEM_PHASE = previous
    }
  })

  test("also defers the scoped ZAP report wrapper during Recon", async () => {
    let called = false
    const report: UpstreamTool = {
      def: { name: "zap_generate_scoped_report", description: "scoped report", inputSchema: { type: "object" } },
      call: async () => {
        called = true
        return { content: [{ type: "text", text: "generated" }] }
      },
    }
    const previous = process.env.CYBERFUL_SUBSYSTEM_PHASE
    process.env.CYBERFUL_SUBSYSTEM_PHASE = "recon"
    const server = await createGatewayServer({ upstreams: [report] })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const reconClient = new Client({ name: "zap-scoped-recon-policy-test", version: "0" })
    await reconClient.connect(clientTransport)
    try {
      const result = await reconClient.callTool({
        name: "zap_generate_scoped_report",
        arguments: {
          file_path: "early.json",
          template: "traditional-json",
          title: "early",
          sites: ["https://example.com"],
        },
      })
      expect("isError" in result && result.isError).toBe(true)
      expect(textContent(result)).toContain("after Recon completes")
      expect(called).toBe(false)
    } finally {
      await reconClient.close()
      await server.closeGateway()
      if (previous === undefined) delete process.env.CYBERFUL_SUBSYSTEM_PHASE
      else process.env.CYBERFUL_SUBSYSTEM_PHASE = previous
    }
  })

  test("requires the scoped wrapper for the terminal client ZAP report", async () => {
    let unscopedCalled = false
    let scopedCalled = false
    const previous = process.env.CYBERFUL_SUBSYSTEM_PHASE
    process.env.CYBERFUL_SUBSYSTEM_PHASE = "report"
    const server = await createGatewayServer({
      upstreams: [
        {
          def: { name: "zap_generate_report", description: "unscoped", inputSchema: { type: "object" } },
          call: async () => {
            unscopedCalled = true
            return { content: [{ type: "text", text: "unscoped" }] }
          },
        },
        {
          def: { name: "zap_generate_scoped_report", description: "scoped", inputSchema: { type: "object" } },
          call: async () => {
            scopedCalled = true
            return { content: [{ type: "text", text: "scoped" }] }
          },
        },
      ],
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "zap-terminal-report-policy-test", version: "0" })
    await client.connect(clientTransport)
    try {
      const unscoped = await client.callTool({ name: "zap_generate_report", arguments: {} })
      expect("isError" in unscoped && unscoped.isError).toBe(true)
      expect(textContent(unscoped)).toContain("zap_generate_scoped_report")
      expect(unscopedCalled).toBe(false)

      const scoped = await client.callTool({ name: "zap_generate_scoped_report", arguments: {} })
      expect("isError" in scoped && scoped.isError).not.toBe(true)
      expect(scopedCalled).toBe(true)
    } finally {
      await client.close()
      await server.closeGateway()
      if (previous === undefined) delete process.env.CYBERFUL_SUBSYSTEM_PHASE
      else process.env.CYBERFUL_SUBSYSTEM_PHASE = previous
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
  test("records only the configured forward transition for the parent runner", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "expert-handoff-test-"))
    const signal = path.join(dir, "handoff.json")
    const previous = {
      phase: process.env.CYBERFUL_SUBSYSTEM_PHASE,
      path: process.env.CYBERFUL_SUBSYSTEM_HANDOFF_PATH,
      successor: process.env.CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR,
      terminal: process.env.CYBERFUL_SUBSYSTEM_HANDOFF_TERMINAL,
    }
    process.env.CYBERFUL_SUBSYSTEM_PHASE = "exploit"
    process.env.CYBERFUL_SUBSYSTEM_HANDOFF_PATH = signal
    process.env.CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR = "hacker"
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
      expect(jsonContent(refused).error).toContain("not allowed")

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
      expect(jsonContent(duplicate).error).toContain("already recorded")
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
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("seals terminal AppSec findings into the fixed host-owned export before accepting handoff", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "expert-terminal-export-test-"))
    const source = path.join(dir, "source")
    const workarea = path.join(dir, "workarea")
    const signal = path.join(dir, "handoff.json")
    await Promise.all([mkdir(source), mkdir(workarea)])
    const keys = [
      "CYBERFUL_SUBSYSTEM_WORKFLOW",
      "CYBERFUL_SUBSYSTEM_PHASE",
      "CYBERFUL_SUBSYSTEM_SOURCE_ROOT",
      "CYBERFUL_SUBSYSTEM_WORKAREA_ROOT",
      "CYBERFUL_SUBSYSTEM_HANDOFF_PATH",
      "CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR",
      "CYBERFUL_SUBSYSTEM_HANDOFF_TERMINAL",
      "CYBERFUL_CODE_GRAPH_LEDGER_KEY",
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
  test("waits for the host Question bridge and returns the human answer", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "expert-question-gateway-test-"))
    const directory = path.join(parent, "bridge")
    const previous = process.env.CYBERFUL_SUBSYSTEM_QUESTION_DIR
    process.env.CYBERFUL_SUBSYSTEM_QUESTION_DIR = directory
    const { SubsystemQuestionBridge } = await import("../question-bridge")
    const bridge = await SubsystemQuestionBridge.start(directory, async () => [["Proceed"]])
    let server: Awaited<ReturnType<typeof createGatewayServer>> | undefined
    let c: McpClient | undefined
    try {
      server = await createGatewayServer({ upstreams: [] })
      const [ct, st] = InMemoryTransport.createLinkedPair()
      await server.connect(st)
      c = new Client({ name: "question-test", version: "0" })
      await c.connect(ct)
      const { tools } = await c.listTools()
      expect(tools.map((tool) => tool.name).sort()).toEqual(["question", "variable"])

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
    } finally {
      await c?.close()
      await server?.closeGateway()
      if (previous === undefined) delete process.env.CYBERFUL_SUBSYSTEM_QUESTION_DIR
      else process.env.CYBERFUL_SUBSYSTEM_QUESTION_DIR = previous
      await bridge.stop()
      await rm(parent, { recursive: true, force: true })
    }
  })

  test("requires visible CAPTCHA attestation and keeps active tools blocked through human verification", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "expert-captcha-gateway-test-"))
    const directory = path.join(parent, "bridge")
    const circuit = path.join(parent, "circuit.json")
    const previous = {
      question: process.env.CYBERFUL_SUBSYSTEM_QUESTION_DIR,
      circuit: process.env.CYBERFUL_SUBSYSTEM_CIRCUIT_BREAKER_PATH,
      phase: process.env.CYBERFUL_SUBSYSTEM_PHASE,
    }
    process.env.CYBERFUL_SUBSYSTEM_QUESTION_DIR = directory
    process.env.CYBERFUL_SUBSYSTEM_CIRCUIT_BREAKER_PATH = circuit
    process.env.CYBERFUL_SUBSYSTEM_PHASE = "recon"
    const { SubsystemQuestionBridge } = await import("../question-bridge")
    const bridge = await SubsystemQuestionBridge.start(directory, async () => [["Solved"]])
    let navigations = 0
    const upstreams: UpstreamTool[] = [
      {
        def: { name: "browser_captcha_handoff", inputSchema: { type: "object" } },
        call: async () => ({
          content: [{ type: "text", text: JSON.stringify({ detected: true, action: "manual_handoff_ready" }) }],
        }),
      },
      {
        def: { name: "browser_captcha_status", inputSchema: { type: "object" } },
        call: async () => ({ content: [{ type: "text", text: JSON.stringify({ detected: false }) }] }),
      },
      {
        def: { name: "browser_navigate", inputSchema: { type: "object" } },
        call: async () => {
          navigations += 1
          return { content: [{ type: "text", text: "navigated" }] }
        },
      },
    ]
    let server: Awaited<ReturnType<typeof createGatewayServer>> | undefined
    let c: McpClient | undefined
    try {
      server = await createGatewayServer({ upstreams })
      const [ct, st] = InMemoryTransport.createLinkedPair()
      await server.connect(st)
      c = new Client({ name: "captcha-test", version: "0" })
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
      await c.callTool({ name: "browser_captcha_handoff", arguments: {} })
      expect(jsonContent(await c.callTool({ name: "browser_navigate", arguments: {} })).error).toContain(
        "awaiting human",
      )
      expect(navigations).toBe(0)
      await c.callTool({ name: "question", arguments: question })
      expect(jsonContent(await c.callTool({ name: "browser_navigate", arguments: {} })).error).toContain(
        "awaiting verification",
      )
      await c.callTool({ name: "browser_captcha_status", arguments: {} })
      expect(textContent(await c.callTool({ name: "browser_navigate", arguments: {} }))).toBe("navigated")
      expect(navigations).toBe(1)
    } finally {
      await c?.close()
      await server?.closeGateway()
      await bridge.stop()
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      restore("CYBERFUL_SUBSYSTEM_QUESTION_DIR", previous.question)
      restore("CYBERFUL_SUBSYSTEM_CIRCUIT_BREAKER_PATH", previous.circuit)
      restore("CYBERFUL_SUBSYSTEM_PHASE", previous.phase)
      await rm(parent, { recursive: true, force: true })
    }
  })
})
