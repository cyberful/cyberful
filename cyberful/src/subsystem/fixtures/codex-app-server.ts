// ── Codex App-Server Contract Fixture ────────────────────────────
// Emulates the JSON-RPC settings, skill registration, turn, and steering
// surface exercised by subsystem tests. Skill registration checks both a
// structured security package with a progressively loaded reference and the
// retained flat ZAP contract, proving that the runtime projects both formats.
// → cyberful/src/subsystem/cli.test.ts — drives this fixture as a subprocess.
// ─────────────────────────────────────────────────────────────────

import { createInterface } from "node:readline"
import path from "node:path"
import { readFile, readdir } from "node:fs/promises"

const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
let skillsReady = process.env.CYBERFUL_FIXTURE_REQUIRE_SKILLS !== "1"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function optionalDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

async function optionalText(file: string) {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (isMissing(error)) return ""
    throw error
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  const message: unknown = JSON.parse(line)
  if (!isRecord(message)) throw new Error("fixture request must be a JSON object")
  if (message.method === "initialize") {
    write({ id: message.id, result: { userAgent: "fixture" } })
    continue
  }
  if (message.method === "thread/start") {
    if (!skillsReady) {
      write({ id: message.id, error: { code: -32000, message: "Cyberful skills were not registered" } })
      continue
    }
    write({ id: message.id, result: { thread: { id: "thread-fixture" } } })
    continue
  }
  if (message.method === "skills/extraRoots/set") {
    const rootsValue = isRecord(message.params) ? message.params.extraRoots : undefined
    const roots = Array.isArray(rootsValue) ? rootsValue.filter((root): root is string => typeof root === "string") : []
    const root = roots[0]
    if (root) {
      const entries = await optionalDirectory(root)
      const methodology = await optionalText(path.join(root, "plan-authorized-pentest", "SKILL.md"))
      const coverage = await optionalText(path.join(root, "plan-authorized-pentest", "references", "coverage-model.md"))
      const zap = await optionalText(path.join(root, "zap", "SKILL.md"))
      skillsReady =
        entries.some((entry) => entry.isDirectory() && entry.name === "plan-authorized-pentest") &&
        methodology.includes("name: plan-authorized-pentest") &&
        methodology.includes("coverage ledger") &&
        coverage.includes("## Control families") &&
        coverage.includes("## Exit criteria") &&
        zap.includes("name: zap") &&
        zap.includes("browser_status") &&
        zap.includes("zap_http_request")
    }
    write({ id: message.id, result: {} })
    continue
  }
  if (message.method === "turn/start") {
    const params = isRecord(message.params) ? message.params : {}
    const expectedEffort = process.env.CYBERFUL_FIXTURE_EXPECT_EFFORT
    if (expectedEffort && params.effort !== expectedEffort) {
      write({ id: message.id, error: { code: -32000, message: `Expected effort ${expectedEffort}` } })
      continue
    }
    if (params.multiAgentMode !== undefined) {
      write({ id: message.id, error: { code: -32000, message: "multiAgentMode must be omitted" } })
      continue
    }
    if (process.env.CYBERFUL_FIXTURE_OPERATION_BEFORE_SETTINGS === "1") {
      write({
        method: "item/started",
        params: {
          threadId: "thread-fixture",
          turnId: "turn-fixture",
          item: { id: "tool-before-settings", type: "commandExecution", command: "pwd" },
        },
      })
    } else {
      write({
        method: "thread/settings/updated",
        params: {
          threadId: "thread-fixture",
          threadSettings: {
            effort: process.env.CYBERFUL_FIXTURE_RESOLVED_EFFORT ?? params.effort ?? null,
            multiAgentMode: process.env.CYBERFUL_FIXTURE_RESOLVED_MULTI_AGENT_MODE ?? "explicitRequestOnly",
          },
        },
      })
    }
    write({ id: message.id, result: { turn: { id: "turn-fixture", status: "inProgress" } } })
    continue
  }
  if (message.method === "turn/interrupt") {
    write({ id: message.id, result: {} })
    continue
  }
  if (message.method === "turn/steer") {
    const params = isRecord(message.params) ? message.params : {}
    const firstInput = Array.isArray(params.input) && isRecord(params.input[0]) ? params.input[0] : undefined
    const text = typeof firstInput?.text === "string" ? firstInput.text : ""
    write({ id: message.id, result: { turnId: "turn-fixture" } })
    write({
      method: "item/completed",
      params: {
        threadId: "thread-fixture",
        turnId: "turn-fixture",
        item: { id: "agent-fixture", type: "agentMessage", text: `steered: ${text}` },
      },
    })
    write({
      method: "turn/completed",
      params: {
        threadId: "thread-fixture",
        turn: { id: "turn-fixture", status: "completed", items: [] },
      },
    })
  }
}
