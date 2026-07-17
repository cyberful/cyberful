// ── Workflow-Scoped Persona Configuration Tests ─────────────────
// Verifies recursive discovery, derived workflow identity, safe duplicate
// semantic names, and the public presentation-only persona schema.
// → cyberful/src/config/agent.ts — owns persona configuration loading.
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import { Exit, Schema } from "effect"
import { mkdir, mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import * as ConfigAgent from "./agent"

const temporaryDirectories: string[] = []

async function fixture(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cyberful-persona-"))
  temporaryDirectories.push(dir)
  await Promise.all(
    Object.entries(files).map(async ([relative, content]) => {
      const target = path.join(dir, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await Bun.write(target, content)
    }),
  )
  return dir
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("ConfigAgent", () => {
  test("loads presentation recursively with workflow-scoped catalog ids", async () => {
    const dir = await fixture({
      "agents/pentest/recon.md": [
        "---",
        "description: Whole-surface reconnaissance",
        "subagents: 3",
        "hidden: false",
        "color: accent",
        "---",
        "",
        "# Recon",
        "",
        "Map the assigned surface.",
      ].join("\n"),
    })

    const agents = await ConfigAgent.load(dir)

    expect(agents["pentest/recon"]).toMatchObject({
      name: "recon",
      workflow: "pentest",
      description: "Whole-surface reconnaissance",
      subagents: 3,
      hidden: false,
      color: "accent",
      prompt: "# Recon\n\nMap the assigned surface.",
    })
  })

  test("keeps repeated semantic persona names scoped by workflow", async () => {
    const dir = await fixture({
      "agents/pentest/report.md": "# Pentest report",
      "agents/audit/report.md": "# Audit report",
    })
    const agents = await ConfigAgent.load(dir)
    expect(agents["pentest/report"]).toMatchObject({ name: "report", workflow: "pentest" })
    expect(agents["audit/report"]).toMatchObject({ name: "report", workflow: "audit" })
    expect(agents["pentest/report"]?.prompt).toBe("# Pentest report")
    expect(agents["audit/report"]?.prompt).toBe("# Audit report")
  })

  test("ignores legacy singular agent and mode directories", async () => {
    const dir = await fixture({
      "agents/brief.md": "# Brief",
      "agent/explore.md": "# Explore",
      "modes/plan.md": "# Plan",
    })

    const agents = await ConfigAgent.load(dir)

    expect(Object.keys(agents)).toEqual(["brief"])
  })

  test("rejects execution fields outside the public persona schema", () => {
    for (const field of [
      "mode",
      "model",
      "options",
      "steps",
      "handoff",
      "handoff_targets",
      "default_tools",
      "share_context",
      "skill_autoload",
    ]) {
      const parsed = Schema.decodeUnknownExit(ConfigAgent.Info)(
        { name: "brief", [field]: true },
        { onExcessProperty: "error" },
      )
      expect(Exit.isFailure(parsed), `${field} must not be accepted`).toBe(true)
    }
  })
})
