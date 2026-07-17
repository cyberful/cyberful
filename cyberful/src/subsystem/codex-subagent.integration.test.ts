// ── Authenticated Codex Subagent Smoke Test ─────────────────────
// Optionally verifies that an Ultra phase can spawn one native child which shares
// its workarea and private gateway without gaining host-owned orchestration.
// → cyberful/src/subsystem/codex.ts — defines the delegation policy under test.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SubsystemCli } from "./cli"
import { SubsystemCodex } from "./codex"
import { SubsystemProvider } from "./provider"
import { SubsystemGateway } from "./gateway/config"
import { isRecord } from "@/util/record"

const enabled = process.env.CYBERFUL_CODEX_SUBAGENT_SMOKE === "1"

test.skipIf(!enabled)(
  "authenticated Ultra turn spawns one native Codex subagent",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cyberful-codex-subagent-smoke-"))
    const transcript = path.join(directory, "transcript.ndjson")
    const runKey = path.basename(directory)
    const gatewayPID = path.join(os.tmpdir(), `${runKey}-gateway-pid.json`)
    const previousEffort = process.env.CYBERFUL_SUBSYSTEM_EFFORT
    try {
      await Promise.all([
        Bun.write(path.join(directory, "root.txt"), "ROOT_MARKER=olive\n"),
        Bun.write(path.join(directory, "child.txt"), "CHILD_MARKER=violet\n"),
      ])
      process.env.CYBERFUL_SUBSYSTEM_EFFORT = "ultra"
      const persona = SubsystemCodex.composeDeveloperInstructions(
        "---\nsubagents: 1\n---\n# Native delegation smoke persona\n\nFollow the requested harmless read-only check.",
        "Stay inside the supplied directory and do not modify its files.",
      )
      expect(persona.delegationEnabled).toBe(true)

      const events: unknown[] = []
      const gateway = SubsystemGateway.gatewayMcpServer("codex-native-subagent-smoke", {
        proxy: false,
        phase: "ask",
        pidSignalPath: gatewayPID,
        env: {
          CYBERFUL_SUBSYSTEM_WORKFLOW: "ask",
          CYBERFUL_SUBSYSTEM_WORKAREA_ROOT: directory,
          CYBERFUL_SUBSYSTEM_SOURCE_ROOT: directory,
        },
      })
      const result = await SubsystemCli.runStreaming(
        {
          provider: SubsystemProvider.codex,
          command: "codex",
          sessionID: "codex-native-subagent-smoke",
          prompt: [
            "This is an authorized, harmless runtime smoke test in a temporary directory.",
            "You must spawn exactly one direct native subagent and wait for it.",
            'Spawn it with fork_turns set to "none"; assign only child.txt and have it return the CHILD_MARKER value.',
            "In parallel, inspect root.txt yourself for ROOT_MARKER.",
            "After the child completes, reply with both marker values and make no file changes.",
          ].join(" "),
          timeoutMs: 180_000,
          spec: {
            cwd: directory,
            permission: { kind: "readonly" },
            model: process.env.CYBERFUL_SUBSYSTEM_MODEL ?? "gpt-5.6-sol",
            developerInstructions: persona.instructions,
            nativeSubagents: persona.delegationEnabled,
            mcpServer: gateway,
            stream: true,
          },
        },
        (event) => events.push(event),
      )
      await Bun.write(transcript, result.stdout)

      expect(result.termination).toBe("completed")
      expect(
        events.some(
          (event) =>
            isRecord(event) &&
            event.method === "thread/settings/updated" &&
            JSON.stringify(event).includes('"effort":"ultra"') &&
            JSON.stringify(event).includes('"multiAgentMode":"explicitRequestOnly"'),
        ),
      ).toBe(true)
      const childThreads = new Set(
        events.flatMap((event) => {
          if (!isRecord(event)) return []
          if (
            !JSON.stringify(event).includes('"type":"subAgentActivity"') ||
            !JSON.stringify(event).includes('"kind":"started"')
          )
            return []
          const params = isRecord(event.params) ? event.params : undefined
          const item = isRecord(params?.item) ? params.item : undefined
          const threadID = item?.agentThreadId
          return typeof threadID === "string" ? [threadID] : []
        }),
      )
      expect(childThreads.size).toBe(1)
      const startup = events.filter((event) => isRecord(event) && event.method === "mcpServer/startupStatus/updated")
      expect(
        startup.some((event) => {
          if (!isRecord(event) || !isRecord(event.params)) return false
          return (
            typeof event.params.threadId === "string" &&
            childThreads.has(event.params.threadId) &&
            event.params.name === "expert-gateway" &&
            event.params.status === "ready"
          )
        }),
      ).toBe(true)
      expect(startup.some((event) => JSON.stringify(event).includes('"status":"failed"'))).toBe(false)
      expect(JSON.parse(await Bun.file(gatewayPID).text()).pid).toBeGreaterThan(1)
      expect(events.some((event) => JSON.stringify(event).includes('"tool":"wait"'))).toBe(true)
      expect(SubsystemProvider.codex.extractResultText(result.stdout)).toContain("olive")
      expect(SubsystemProvider.codex.extractResultText(result.stdout)).toContain("violet")
    } finally {
      if (previousEffort === undefined) delete process.env.CYBERFUL_SUBSYSTEM_EFFORT
      else process.env.CYBERFUL_SUBSYSTEM_EFFORT = previousEffort
      if (process.env.CYBERFUL_CODEX_SUBAGENT_SMOKE_KEEP !== "1")
        await Promise.all([
          rm(directory, { recursive: true, force: true }),
          rm(gatewayPID, { force: true }),
        ])
    }
  },
  180_000,
)
