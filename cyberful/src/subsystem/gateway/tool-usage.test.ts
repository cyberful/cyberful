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
      agent_run_id: "run-exploit-1",
      agent_role: "subagent",
      parent_run_id: "run-root-1",
      tool_call_id: "call-1",
      tool: "nuclei",
      tool_action: "search",
      duration_ms: 420,
      outcome: "ok",
      result_count: 3,
      argument_digest: "a".repeat(64),
      hypothesis_id: "H-SSRF",
      peak_rps: 5,
      bytes_out: 900,
      marker_attested: true,
      egress_host: "api.example.test",
      egress_method: "POST",
      egress_http_status: 403,
      egress_path_family: "/v1/:id",
      egress_response_bytes: 512,
      egress_attempts: 1,
      egress_redirects: 0,
      egress_deadline_ms: 3_000,
      egress_route: "cyberful-os/docker-direct",
      egress_observability: "observed",
      egress_destination_changed: false,
      suspected_count: 1,
    })
    await recorder.record({
      tool: "browser_navigate",
      duration_ms: 12,
      outcome: "error",
      error_code: "ECONNRESET",
      browser_profile: 1,
    })
    await recorder.record({
      tool: "web_search",
      duration_ms: 20,
      outcome: "ok",
      argument_digest: "b".repeat(64),
      browser_profile: "search",
      egress_host: "html.duckduckgo.com",
      egress_method: "GET",
      egress_path_family: "/html",
      egress_route: "browser/direct-search",
      egress_observability: "inferred",
    })
    await recorder.close()

    const csv = await readFile(path.join(root, "raw", "operations", "tool-usage.csv"), "utf8")
    expect(csv).toContain("time_iso,phase,agent,agent_run_id,agent_role,parent_run_id,tool_call_id,tool,tool_action")
    expect(csv).toContain("exploit,exploit,run-exploit-1,subagent,run-root-1,call-1,nuclei,search,420,ok,3")
    expect(csv).toContain(`${"a".repeat(64)},H-SSRF`)
    expect(csv).toContain("api.example.test,POST,403,/v1/:id")
    expect(csv).toContain("512,1,0,3000,cyberful-os/docker-direct,observed,false")
    expect(csv).not.toContain("decision")
    expect(csv).not.toContain("reason_code")
    expect(csv).not.toContain("rationale")
    const [header, ...rows] = csv.trim().split("\n")
    expect([header, ...rows]).toHaveLength(4)
    const columns = header!.split(",")
    const failed = rows.find((row) => row.split(",")[columns.indexOf("tool")] === "browser_navigate")
    expect(failed).toBeDefined()
    const failedValues = failed!.split(",")
    expect(failedValues[columns.indexOf("error_class")]).toBe("tool_reported_error")
    expect(failedValues[columns.indexOf("error_code")]).toBe("ECONNRESET")
    expect(failedValues[columns.indexOf("browser_profile")]).toBe("1")
    const search = rows.find((row) => row.split(",")[columns.indexOf("tool")] === "web_search")
    expect(search).toBeDefined()
    const searchValues = search!.split(",")
    expect(searchValues[columns.indexOf("browser_profile")]).toBe("search")
    expect(searchValues[columns.indexOf("egress_route")]).toBe("browser/direct-search")
    expect(csv).not.toContain("private search terms")
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
