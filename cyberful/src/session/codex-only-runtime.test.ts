// ── Primary Codex Session Runtime Tests ───────────────────────────
// Verifies that every built-in workflow phase keeps Codex as its primary
// runtime and that no user-selectable AI SDK routing surface reappears.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { Exit, Schema } from "effect"
import { SubsystemPhase } from "@/subsystem/phase"
import { MessageID, SessionID } from "./schema"
import { PromptInput } from "./prompt"
import { EventV2 } from "@/event-v2"
import { isRecord } from "@/util/record"
import "./event-v2"

describe("primary Codex session boundary", () => {
  test("the prompt and phase gateway have no AI SDK routing dependency", async () => {
    const sources = await Promise.all(
      ["./prompt.ts", "../subsystem/gateway/server.ts"].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
    )
    for (const forbidden of [
      'from "ai"',
      'from "@ai-sdk/provider"',
      'from "@/provider/provider"',
      'from "./llm"',
      'from "./processor"',
      'from "./compaction"',
      'from "./model-router"',
    ]) {
      for (const source of sources) expect(source).not.toContain(forbidden)
    }
    for (const forbidden of ["SessionHandoff", "Agent.Service"]) expect(sources[0]).not.toContain(forbidden)
  })

  test("the workspace manifests expose no AI SDK dependency", async () => {
    const [workspaceValue, runtimeValue]: unknown[] = await Promise.all([
      Bun.file(new URL("../../../package.json", import.meta.url)).json(),
      Bun.file(new URL("../../package.json", import.meta.url)).json(),
    ])
    if (!isRecord(workspaceValue) || !isRecord(runtimeValue)) throw new Error("workspace manifests must be objects")
    const workspaces = isRecord(workspaceValue.workspaces) ? workspaceValue.workspaces : undefined
    const catalog = isRecord(workspaces?.catalog) ? workspaces.catalog : undefined
    const dependencies = isRecord(runtimeValue.dependencies) ? runtimeValue.dependencies : undefined

    expect(catalog).not.toHaveProperty("ai")
    expect(dependencies).not.toHaveProperty("ai")
    expect(dependencies).not.toHaveProperty("@ai-sdk/provider")
  })

  test("the request schema exposes no model/provider tuning surface", () => {
    expect(Object.keys(PromptInput.fields).sort()).toEqual(
      ["agent", "delivery", "messageID", "noReply", "parts", "sessionID", "system", "workarea"].sort(),
    )
    const decode = Schema.decodeUnknownExit(PromptInput)
    const base = {
      sessionID: SessionID.make("ses_codex_only"),
      messageID: MessageID.make("msg_codex_only"),
      agent: "brief",
    }
    expect(Exit.isSuccess(decode({ ...base, parts: [{ type: "text", text: "run" }] }))).toBe(true)
    expect(Exit.isFailure(decode({ ...base, parts: [{ type: "agent", name: "delegate" }] }))).toBe(true)
    expect(
      Exit.isFailure(
        decode({
          ...base,
          parts: [{ type: "subtask", agent: "delegate", description: "x", prompt: "x" }],
        }),
      ),
    ).toBe(true)
  })

  test("the complete production chain is registered as Codex phases", () => {
    const workflow = SubsystemPhase.listWorkflows().find((item) => item.name === "pentest")
    expect(workflow?.kind === "workflow" ? workflow.phases.map((phase) => phase.name) : undefined).toEqual([
      "brief",
      "recon",
      "exploit",
      "hacker",
      "verify",
      "report",
    ])
    if (workflow?.kind === "workflow")
      for (const phase of workflow.phases) expect(SubsystemPhase.isExpertPhase("pentest", phase.name)).toBe(true)
    expect(SubsystemPhase.isExpertPhase("pentest", "generic-agent")).toBe(false)
    expect(SubsystemPhase.phaseOwner("pentest", "generic-agent")).toBe("unknown")
  })

  test("Codex activity has no retired model-step lifecycle events", () => {
    const types = [...EventV2.definitions()].map((event) => event.type)
    expect(types).toContain("session.next.subsystem.phase_activity")
    expect(types).not.toContain("session.next.codex.phase_activity")
    expect(types).not.toContain("session.next.model.switched")
    expect(types.filter((type) => type.startsWith("session.next.step."))).toEqual([])
  })
})
