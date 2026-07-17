// ── Gateway Tool Usage Tests ──────────────────────────────────────
// Verifies that routine gateway calls produce one metadata-only,
// engagement-local CSV without storing sensitive arguments or response content.
// → cyberful/src/subsystem/gateway/tool-usage.ts — owns the local ledger.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ToolUsageRecorder } from "./tool-usage"

test("auto-populates one metadata-only CSV inside the engagement workarea", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-tool-usage-"))
  const previous = {
    root: process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT,
    phase: process.env.CYBERFUL_SUBSYSTEM_PHASE,
    label: process.env.CYBERFUL_SUBSYSTEM_LABEL,
  }
  process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = root
  process.env.CYBERFUL_SUBSYSTEM_PHASE = "exploit"
  process.env.CYBERFUL_SUBSYSTEM_LABEL = "exploit"
  try {
    const recorder = new ToolUsageRecorder()
    await recorder.record({
      tool: "nuclei_run_scoped",
      duration_ms: 420,
      outcome: "ok",
      peak_rps: 5,
      bytes_out: 900,
      marker_attested: true,
      suspected_count: 1,
    })
    await recorder.close()

    const csv = await readFile(path.join(root, "raw", "operations", "tool-usage.csv"), "utf8")
    expect(csv).toContain("time_iso,phase,agent,tool,duration_ms,outcome")
    expect(csv).toContain("exploit,exploit,nuclei_run_scoped,420,ok,5,900,true")
    expect(csv).not.toContain("decision")
    expect(csv).not.toContain("reason_code")
    expect(csv).not.toContain("rationale")
    expect(csv.trim().split("\n")).toHaveLength(2)
  } finally {
    if (previous.root === undefined) delete process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT
    else process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = previous.root
    if (previous.phase === undefined) delete process.env.CYBERFUL_SUBSYSTEM_PHASE
    else process.env.CYBERFUL_SUBSYSTEM_PHASE = previous.phase
    if (previous.label === undefined) delete process.env.CYBERFUL_SUBSYSTEM_LABEL
    else process.env.CYBERFUL_SUBSYSTEM_LABEL = previous.label
    await rm(root, { recursive: true, force: true })
  }
})
