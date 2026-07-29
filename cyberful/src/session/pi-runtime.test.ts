// ── Primary Pi Session Runtime Tests ──────────────────────────────
// Verifies that every built-in workflow phase keeps Pi as its subsystem
// runtime and that no user-selectable AI SDK routing surface reappears.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { Exit, Schema } from "effect"
import { SubsystemPhase } from "@/subsystem/phase"
import { MessageID, SessionID } from "./schema"
import { PromptInput } from "./prompt-input"
import { Event } from "@/event"
import { isRecord } from "@/util/record"
import "./event"

describe("primary Pi session boundary", () => {
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
      sessionID: SessionID.make("ses_pi_only"),
      messageID: MessageID.make("msg_pi_only"),
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

  test("the complete production chain is registered as Pi phases", () => {
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

  test("Pi activity uses only the generic subsystem lifecycle event", () => {
    const types = [...Event.definitions()].map((event) => event.type)
    expect(types).toContain("session.next.subsystem.phase_activity")
    expect(types).not.toContain("session.next.pi.phase_activity")
    expect(types).not.toContain("session.next.model.switched")
    expect(types.filter((type) => type.startsWith("session.next.step."))).toEqual([])
  })

  test("subsystem reasoning observations stay out of the public phase activity stream", async () => {
    const source = await Bun.file(new URL("./prompt.ts", import.meta.url)).text()
    expect(source).not.toContain("reasoningObservation")
    expect(source.match(/if \(activity\.kind === "reasoning"\) return/g)).toHaveLength(2)
  })
})
