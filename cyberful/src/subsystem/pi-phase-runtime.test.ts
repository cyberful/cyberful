// ── Pi Live Projection Tests ─────────────────────────────────────
// Verifies that multi-megabyte evidence remains complete on disk while the TUI
//   event receives only its bounded projection and content-addressed reference.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import type { AgentEvent } from "./agent-subsystem"
import * as Builtin from "@/builtin"
import { PiSkills } from "./pi-skills"
import { eagerSkillTools, projectLiveEvent, TUI_TOOL_OUTPUT_BYTES } from "./pi-phase-runtime"

describe("Pi live tool output projection", () => {
  test("a 3.5 MB result reaches the TUI only as 12 KiB plus a lazy artifact reference", async () => {
    const workarea = await realpath(await mkdtemp(path.join(tmpdir(), "cyberful-live-projection-")))
    const output = `${"scanner-result αβγ\n".repeat(190_000)}tail`
    const event: AgentEvent = {
      type: "activity",
      runID: "run_projection",
      activity: {
        kind: "output",
        callID: "call_large",
        text: output,
      },
    }
    try {
      expect(Buffer.byteLength(output)).toBeGreaterThan(3_500_000)
      const projected = await projectLiveEvent(event, workarea)
      if (projected.type !== "activity" || projected.activity.kind !== "output")
        throw new Error("projection changed the event kind")
      expect(Buffer.byteLength(projected.activity.text)).toBeLessThanOrEqual(TUI_TOOL_OUTPUT_BYTES)
      expect(projected.activity.artifact).toMatchObject({
        bytes: Buffer.byteLength(output),
        sha256: createHash("sha256").update(output).digest("hex"),
      })
      const artifact = projected.activity.artifact
      if (!artifact) throw new Error("large projection did not preserve an artifact")
      expect(await readFile(path.join(workarea, artifact.path), "utf8")).toBe(output)
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })
})

describe("Pi eager skill tools", () => {
  test("keeps search and read visible on the first request", async () => {
    const skills = await PiSkills.discover({ roots: [path.join(Builtin.DIR, "skills")] })

    expect(eagerSkillTools(skills).map((tool) => tool.name)).toEqual(["skill_search", "skill_read"])
  })
})
