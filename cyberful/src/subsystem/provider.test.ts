// ── Codex Provider Adapter Tests ─────────────────────────────────
// Verifies production argument construction, sandbox posture, gateway projection,
// event mapping, and private-environment separation for phase invocations.
// → cyberful/src/subsystem/provider.ts — implements the tested adapter.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { SubsystemProvider } from "./provider"
import type { SubsystemRunSpec } from "./provider"

const at = (permission: SubsystemRunSpec["permission"], extra: Partial<SubsystemRunSpec> = {}): SubsystemRunSpec => ({
  cwd: "/workarea",
  permission,
  ...extra,
})

const gateway: SubsystemProvider.SubsystemMcpServer = {
  name: "expert-gateway",
  command: "/bun",
  args: ["/gateway.ts"],
  env: {
    CYBERFUL_SUBSYSTEM_ENV_PATH: "/private/gateway-environment.json",
  },
  privateEnv: { CYBERFUL_SUBSYSTEM_SESSION: "ses_1", CYBER_ZAP_API_KEY: "must-not-appear" },
}

function withWebSearch<T>(value: "0" | "1", fn: () => T) {
  const previous = process.env.WEB_SEARCH
  process.env.WEB_SEARCH = value
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.WEB_SEARCH
    else process.env.WEB_SEARCH = previous
  }
}

function withCodexEffort<T>(value: string, fn: () => T) {
  const previous = process.env.CYBERFUL_SUBSYSTEM_EFFORT
  process.env.CYBERFUL_SUBSYSTEM_EFFORT = value
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.CYBERFUL_SUBSYSTEM_EFFORT
    else process.env.CYBERFUL_SUBSYSTEM_EFFORT = previous
  }
}

describe("codex adapter", () => {
  test("runs ephemeral JSONL with ignored personal config, workspace sandbox, network and no approvals", () => {
    const { args } = withCodexEffort("xhigh", () =>
      withWebSearch("1", () =>
        SubsystemProvider.codex.buildArgs(
          at(
            { kind: "autonomous" },
            {
              model: "gpt-5.6-sol",
              developerInstructions: "phase persona\n\ncyberful posture",
              nativeSubagents: true,
              mcpServer: gateway,
            },
          ),
        ),
      ),
    )
    expect(args.indexOf("--ask-for-approval")).toBeLessThan(args.indexOf("exec"))
    expect(args).toEqual(
      expect.arrayContaining([
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "never",
        "--model",
        "gpt-5.6-sol",
      ]),
    )
    expect(args).toContain("sandbox_workspace_write.network_access=true")
    expect(args).toContain("sandbox_workspace_write.exclude_slash_tmp=true")
    expect(args).toContain('web_search="live"')
    expect(args).not.toContain("--search")
    expect(args).toContain('model_reasoning_effort="xhigh"')
    expect(args).toContain('developer_instructions="phase persona\\n\\ncyberful posture"')
    expect(args).toContain("features.multi_agent=true")
    expect(args).toContain("features.multi_agent_v2=false")
    expect(args.some((arg) => arg.startsWith("model_instructions_file="))).toBe(false)
    expect(args).toContain('mcp_servers.expert-gateway.command="/bun"')
    expect(args.find((arg) => arg.startsWith("mcp_servers.expert-gateway.env="))).toContain(
      '"CYBERFUL_SUBSYSTEM_ENV_PATH"="/private/gateway-environment.json"',
    )
    expect(args.join(" ")).not.toContain("must-not-appear")
    expect(args).toContain('mcp_servers.expert-gateway.default_tools_approval_mode="approve"')
    expect(args.at(-1)).toBe("-")
    expect(args.join(" ")).not.toContain("disallowed")
  })

  test("readonly selects the read-only sandbox", () => {
    const { args } = SubsystemProvider.codex.buildArgs(at({ kind: "readonly" }))
    expect(args).toEqual(expect.arrayContaining(["--sandbox", "read-only"]))
  })

  test("builds an isolated app-server transport with one explicit gateway", () => {
    const built = withWebSearch("1", () =>
      SubsystemProvider.codex.buildAppServerArgs(
        at(
          { kind: "autonomous" },
          {
            model: "gpt-5.6-sol",
            developerInstructions: "phase persona\n\ncyberful posture",
            nativeSubagents: true,
            mcpServer: gateway,
          },
        ),
      ),
    )
    expect(built.args.slice(0, 3)).toEqual(["app-server", "--stdio", "--strict-config"])
    expect(built.args).toContain('web_search="live"')
    expect(built.args).toContain('developer_instructions="phase persona\\n\\ncyberful posture"')
    expect(built.args).toContain("features.multi_agent=true")
    expect(built.args).toContain("features.multi_agent_v2=false")
    expect(built.args.some((arg) => arg.startsWith("model_instructions_file="))).toBe(false)
    const servers = built.args.find((arg) => arg.startsWith("mcp_servers="))
    expect(servers).toContain('"expert-gateway"={command="/bun"')
    expect(servers).toContain('"CYBERFUL_SUBSYSTEM_ENV_PATH"="/private/gateway-environment.json"')
    expect(servers).not.toContain("must-not-appear")
    expect(servers).toContain('default_tools_approval_mode="approve"')
  })

  test("disables the Codex web search tool when WEB_SEARCH=0", () => {
    const built = withWebSearch("0", () => [
      SubsystemProvider.codex.buildArgs(at({ kind: "autonomous" })),
      SubsystemProvider.codex.buildAppServerArgs(at({ kind: "autonomous" })),
    ])
    for (const command of built) expect(command.args).toContain('web_search="disabled"')
  })

  test("keeps native multi-agent tools closed unless the phase explicitly authorizes them", () => {
    const commands = [
      SubsystemProvider.codex.buildArgs(at({ kind: "autonomous" })),
      SubsystemProvider.codex.buildAppServerArgs(at({ kind: "autonomous" })),
    ]
    for (const command of commands) {
      expect(command.args).toContain("features.multi_agent=false")
      expect(command.args).toContain("features.multi_agent_v2=false")
    }
  })

  test("enforces an offline sandbox independently of the global web-search setting", () => {
    const built = withWebSearch("1", () => [
      SubsystemProvider.codex.buildArgs(at({ kind: "autonomous" }, { networkAccess: false })),
      SubsystemProvider.codex.buildAppServerArgs(at({ kind: "autonomous" }, { networkAccess: false })),
    ])
    for (const command of built) {
      expect(command.args).toContain('web_search="disabled"')
      expect(command.args).toContain("sandbox_workspace_write.network_access=false")
      expect(command.args).not.toContain("sandbox_workspace_write.network_access=true")
    }
  })

  test("extracts the last completed agent message", () => {
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "raw" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final" } }),
    ].join("\n")
    expect(SubsystemProvider.codex.extractResultText(stdout)).toBe("final")
  })

  test("extracts and maps app-server notifications", () => {
    const completed = {
      method: "item/completed",
      params: { item: { id: "a1", type: "agentMessage", text: "app-server final" } },
    }
    expect(SubsystemProvider.codex.extractResultText(JSON.stringify(completed))).toBe("app-server final")
    expect(SubsystemProvider.codex.streamActivities(completed)).toEqual([{ kind: "text", text: "app-server final" }])
    expect(
      SubsystemProvider.codex.streamActivities({
        method: "item/started",
        params: { item: { id: "m1", type: "mcpToolCall", tool: "mcp__expert-gateway__question", arguments: {} } },
      }),
    ).toEqual([{ kind: "tool", tool: "question", input: {}, callID: "m1" }])
  })

  test("maps the app-server thread total to provider-neutral generated-token usage", () => {
    expect(
      SubsystemProvider.codex.streamActivities({
        method: "thread/tokenUsage/updated",
        params: {
          tokenUsage: {
            total: { outputTokens: 640 },
            last: { outputTokens: 90 },
          },
        },
      }),
    ).toEqual([{ kind: "progress", usage: { generatedTokens: 640 } }])
  })

  test("maps every available app-server usage dimension and thread scope", () => {
    expect(
      SubsystemProvider.codex.streamActivities({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thr_child",
          tokenUsage: {
            total: { inputTokens: 900, cachedInputTokens: 300, outputTokens: 240, reasoningOutputTokens: 80 },
          },
        },
      }),
    ).toEqual([
      {
        kind: "progress",
        usage: {
          generatedTokens: 240,
          inputTokens: 900,
          reasoningTokens: 80,
          cacheReadTokens: 300,
          scopeID: "thr_child",
        },
      },
    ])
  })

  test("surfaces MCP startup readiness and failures with one stable call identity", () => {
    expect(
      SubsystemProvider.codex.streamActivities({
        method: "mcpServer/startupStatus/updated",
        params: { threadId: "thr_child", name: "expert-gateway", status: "starting" },
      }),
    ).toEqual([
      {
        kind: "tool",
        tool: "mcp.expert-gateway.startup",
        input: { status: "starting" },
        callID: "mcp-startup-thr_child-expert-gateway",
        actor: { id: "thr_child" },
      },
    ])
    expect(
      SubsystemProvider.codex.streamActivities({
        method: "mcpServer/startupStatus/updated",
        params: {
          threadId: "thr_child",
          name: "expert-gateway",
          status: "failed",
          error: "handshake closed",
          failureReason: "transport-closed",
        },
      }),
    ).toEqual([
      {
        kind: "output",
        text: JSON.stringify({ status: "failed", error: "handshake closed", failureReason: "transport-closed" }),
        callID: "mcp-startup-thr_child-expert-gateway",
        actor: { id: "thr_child" },
      },
    ])
  })

  test("surfaces resolved Codex settings as one paired diagnostic card", () => {
    expect(
      SubsystemProvider.codex.streamActivities({
        method: "thread/settings/updated",
        params: {
          threadId: "thr_1",
          threadSettings: { effort: "ultra", multiAgentMode: "explicitRequestOnly" },
        },
      }),
    ).toEqual([
      {
        kind: "tool",
        tool: "codex.settings",
        input: { effort: "ultra", multiAgentMode: "explicitRequestOnly" },
        callID: "codex-settings-thr_1",
      },
      {
        kind: "output",
        text: "Resolved effort=ultra, multiAgentMode=explicitRequestOnly",
        callID: "codex-settings-thr_1",
      },
    ])
  })

  test("maps native spawn and child activity into collaboration and lifecycle rows", () => {
    const spawn = {
      id: "collab_1",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      prompt: "inspect the authenticated surface",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      senderThreadId: "root",
      receiverThreadIds: ["child"],
      status: "completed",
      agentsStates: { child: { status: "completed", message: "done" } },
    }
    expect(SubsystemProvider.codex.streamActivities({ method: "item/started", params: { item: spawn } })).toEqual([
      {
        kind: "tool",
        tool: "subagent.spawnAgent",
        input: {
          operation: "spawnAgent",
          prompt: "inspect the authenticated surface",
          model: "gpt-5.6-sol",
          reasoningEffort: "ultra",
          senderThreadId: "root",
          receiverThreadIds: ["child"],
        },
        callID: "collab_1",
      },
    ])
    expect(SubsystemProvider.codex.streamActivities({ method: "item/completed", params: { item: spawn } })).toEqual([
      {
        kind: "output",
        text: JSON.stringify({
          status: "completed",
          receiverThreadIds: ["child"],
          agentsStates: { child: { status: "completed", message: "done" } },
        }),
        callID: "collab_1",
      },
      {
        kind: "agent",
        actor: { id: "child" },
        state: "completed",
        transitionID: "collab_1:child:completed",
      },
    ])
    expect(
      SubsystemProvider.codex.streamActivities({
        method: "item/completed",
        params: {
          item: {
            id: "activity_1",
            type: "subAgentActivity",
            kind: "started",
            agentPath: "/root/recon_surface",
            agentThreadId: "child",
          },
        },
      }),
    ).toEqual([
      {
        kind: "agent",
        actor: { id: "child", label: "recon_surface" },
        state: "started",
        transitionID: "activity_1",
      },
    ])
  })

  test("projects opaque actor references through one isolated subsystem run", () => {
    const project = SubsystemProvider.createActivityActorProjection()
    expect(
      project({ kind: "agent", actor: { id: "root" }, state: "active", transitionID: "root-active" }),
    ).toBeUndefined()
    expect(project({ kind: "text", text: "root work", actor: { id: "root" } })).toEqual({
      kind: "text",
      text: "root work",
      actor: { id: "root" },
    })
    expect(
      project({
        kind: "agent",
        actor: { id: "child", label: "surface", parentID: "root" },
        state: "started",
        transitionID: "child-started",
      }),
    ).toEqual({
      kind: "agent",
      actor: { id: "child", label: "surface", parentID: "root" },
      state: "started",
      transitionID: "child-started",
    })
    expect(project({ kind: "tool", tool: "httpx", input: {}, callID: "call", actor: { id: "child" } })).toEqual({
      kind: "tool",
      tool: "httpx",
      input: {},
      callID: "call",
      actor: { id: "child", label: "surface", parentID: "root" },
    })
    expect(
      project({ kind: "agent", actor: { id: "child" }, state: "completed", transitionID: "child-completed" }),
    ).toEqual({
      kind: "agent",
      actor: { id: "child", label: "surface", parentID: "root" },
      state: "completed",
      transitionID: "child-completed",
    })
  })

  test("attributes app-server child work and terminal state by thread id", () => {
    expect(
      SubsystemProvider.codex.streamActivities({
        method: "item/started",
        params: {
          threadId: "child",
          item: { id: "cmd", type: "commandExecution", command: "pwd" },
        },
      }),
    ).toEqual([{ kind: "tool", tool: "shell", input: { command: "pwd" }, callID: "cmd", actor: { id: "child" } }])
    expect(
      SubsystemProvider.codex.streamActivities({
        method: "turn/completed",
        params: { threadId: "child", turn: { id: "turn-1", status: "failed" } },
      }),
    ).toEqual([{ kind: "agent", actor: { id: "child" }, state: "failed", transitionID: "child:turn-1:completed" }])
  })

  test("keeps one native child label across its lifecycle, prose, tool and output", () => {
    const project = SubsystemProvider.createActivityActorProjection()
    const events = [
      {
        method: "item/completed",
        params: {
          threadId: "root",
          item: {
            id: "spawned",
            type: "subAgentActivity",
            kind: "started",
            agentThreadId: "child",
            agentPath: "/root/surface",
          },
        },
      },
      { method: "turn/started", params: { threadId: "child", turn: { id: "turn" } } },
      {
        method: "item/completed",
        params: { threadId: "child", item: { id: "message", type: "agentMessage", text: "mapping" } },
      },
      {
        method: "item/started",
        params: { threadId: "child", item: { id: "command", type: "commandExecution", command: "pwd" } },
      },
      {
        method: "item/completed",
        params: {
          threadId: "child",
          item: { id: "command", type: "commandExecution", aggregatedOutput: "/workarea\n" },
        },
      },
      { method: "turn/completed", params: { threadId: "child", turn: { id: "turn", status: "completed" } } },
    ]
    const activities = events
      .flatMap((event) => SubsystemProvider.codex.streamActivities(event))
      .map(project)
      .filter((activity): activity is SubsystemProvider.PhaseActivity => activity !== undefined)

    expect(activities.map((activity) => activity.actor?.label)).toEqual([
      "surface",
      "surface",
      "surface",
      "surface",
      "surface",
      "surface",
    ])
    expect(activities.filter((activity) => activity.kind === "agent").map((activity) => activity.state)).toEqual([
      "started",
      "active",
      "completed",
    ])
    expect(activities.find((activity) => activity.kind === "output")).toMatchObject({
      text: "/workarea",
      actor: { id: "child", label: "surface", parentID: "root" },
    })
  })

  test("maps legacy JSONL turn usage through the same generated-token contract", () => {
    expect(
      SubsystemProvider.codex.streamActivities({
        type: "turn.completed",
        usage: { output_tokens: 75 },
      }),
    ).toEqual([{ kind: "progress", usage: { generatedTokens: 75 } }])
  })

  test("maps agent, shell and MCP events into the provider-neutral live feed", () => {
    expect(
      SubsystemProvider.codex.streamActivities({
        type: "item.started",
        item: { id: "c1", type: "command_execution", command: "pwd" },
      }),
    ).toEqual([{ kind: "tool", tool: "shell", input: { command: "pwd" }, callID: "c1" }])
    expect(
      SubsystemProvider.codex.streamActivities({
        type: "item.started",
        item: { id: "m1", type: "mcp_tool_call", tool: "mcp__expert-gateway__httpx", arguments: { url: "x" } },
      }),
    ).toEqual([{ kind: "tool", tool: "httpx", input: { url: "x" }, callID: "m1" }])
    expect(
      SubsystemProvider.codex.streamActivities({
        type: "item.completed",
        item: { id: "m1", type: "mcp_tool_call", result: { ok: true } },
      }),
    ).toEqual([{ kind: "output", text: '{"ok":true}', callID: "m1" }])
    expect(
      SubsystemProvider.codex.streamActivities({
        type: "item.completed",
        item: {
          id: "m2",
          type: "mcp_tool_call",
          result: {
            content: [{ type: "text", text: '{\n  "ok": true,\n  "variables": []\n}' }],
            structured_content: null,
          },
        },
      }),
    ).toEqual([{ kind: "output", text: '{\n  "ok": true,\n  "variables": []\n}', callID: "m2" }])
    expect(
      SubsystemProvider.codex.streamActivities({
        type: "item.completed",
        item: { type: "agent_message", text: " done " },
      }),
    ).toEqual([{ kind: "text", text: "done" }])
  })
})
