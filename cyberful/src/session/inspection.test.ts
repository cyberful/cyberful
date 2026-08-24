// ── Coding-Agent Inspection Tests ───────────────────────────────
// Verifies durable provenance, partial-source diagnostics, lifecycle projection,
// actor counts, freshness, and omission of opaque failure payloads.
// → cyberful/src/session/inspection.ts — builds SessionInspectionV1.
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { Schema } from "effect"
import { Session } from "./session"
import { buildSessionInspection } from "./inspection"

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), `cyberful-${label}-`)))
  temporary.push(directory)
  return directory
}

function session() {
  return Schema.decodeUnknownSync(Session.Info)({
    id: "ses_inspection_test",
    slug: "inspection-test",
    projectID: "project-test",
    directory: "/authorized/lab",
    title: "Inspection test",
    workflow: "pentest",
    agent: "brief",
    version: "0.4.0",
    time: { created: 1, updated: 2 },
  }) as Session.Info
}

describe("SessionInspectionV1", () => {
  test("labels a local snapshot as durable and diagnoses a missing workarea", async () => {
    const approvalRoot = await temporaryDirectory("inspection-approval")
    const snapshot = await buildSessionInspection({
      session: session(),
      messages: [],
      approvalRoot,
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    })

    expect(snapshot.schemaVersion).toBe(1)
    expect(snapshot.source).toEqual({ mode: "durable", connection: "not-attached", reliable: false })
    expect(snapshot.lifecycle).toBeUndefined()
    expect(snapshot.actors).toEqual({ running: 0, completed: 0, failed: 0, total: 0, active: [] })
    expect(snapshot.diagnostics).toContainEqual({
      component: "workarea",
      code: "not-available",
      message: "The session has not published a durable workarea yet.",
    })
  })

  test("projects valid lifecycle facts without opaque failures", async () => {
    const workarea = await temporaryDirectory("inspection-workarea")
    const approvalRoot = await temporaryDirectory("inspection-approval")
    await mkdir(path.join(workarea, "raw", "operations"), { recursive: true })
    await Bun.write(
      path.join(workarea, "raw", "operations", "run-state.json"),
      JSON.stringify({
        version: 2,
        workflow: "pentest",
        phase: "report",
        attempt: 2,
        status: "running",
        mode: "closeout",
        deadline_at: "2026-08-24T12:10:00.000Z",
        budget_remaining_ms: 600_000,
        closeout_reserve_ms: 300_000,
        closeout_remaining_ms: 120_000,
        last_progress_at: "2026-08-24T11:59:58.000Z",
        updated_at: "2026-08-24T11:59:59.000Z",
        actors: [
          {
            id: "run_root",
            role: "root",
            provider: "openai",
            model: "model",
            status: "running",
            last_activity_at: "2026-08-24T11:59:59.000Z",
            tool_calls: 4,
            failure: { credential: "actor-secret" },
          },
          {
            id: "run_child",
            parent_id: "run_root",
            role: "subagent",
            status: "completed",
            last_activity_at: "2026-08-24T11:59:50.000Z",
            tool_calls: 2,
          },
        ],
        retry: {
          run_id: "run_root",
          state: "scheduled",
          attempt: 2,
          retry_wait_ms: 1_000,
          failure: { responseBody: "provider-secret" },
        },
        recoveries: [],
        steering: [],
        failure: { transcript: "lifecycle-secret" },
      }),
    )

    const snapshot = await buildSessionInspection({
      session: session(),
      messages: [],
      workarea: { root: workarea, name: "inspection-workarea" },
      approvalRoot,
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    })

    expect(snapshot.lifecycle).toMatchObject({
      phase: "report",
      attempt: 2,
      mode: "closeout",
      freshnessMs: 1_000,
      retry: { runID: "run_root", attempt: 2, retryWaitMs: 1_000 },
    })
    expect(snapshot.actors).toMatchObject({ running: 1, completed: 1, failed: 0, total: 2 })
    expect(snapshot.actors.active.map((actor) => actor.id)).toEqual(["run_root"])
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain("actor-secret")
    expect(serialized).not.toContain("provider-secret")
    expect(serialized).not.toContain("lifecycle-secret")
    expect(snapshot.findings).toMatchObject({ currentCount: 0, current: [] })
    expect(snapshot.hypotheses).toMatchObject({ activeCount: 0, active: [] })
    expect(snapshot.providerUsage).toBeDefined()
    expect(snapshot.diagnostics).toEqual([])
  })

  test("keeps a malformed lifecycle unavailable with an explicit diagnostic", async () => {
    const workarea = await temporaryDirectory("inspection-malformed")
    const approvalRoot = await temporaryDirectory("inspection-approval")
    await mkdir(path.join(workarea, "raw", "operations"), { recursive: true })
    await Bun.write(path.join(workarea, "raw", "operations", "run-state.json"), "not-json-inspection-secret")

    const snapshot = await buildSessionInspection({
      session: session(),
      messages: [],
      workarea: { root: workarea, name: "inspection-malformed" },
      approvalRoot,
    })

    expect(snapshot.lifecycle).toBeUndefined()
    expect(snapshot.diagnostics.some((item) => item.component === "lifecycle" && item.code === "not-available")).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain("not-json-inspection-secret")
  })

  test("contains a structurally decoded but invalid lifecycle to its component diagnostic", async () => {
    const workarea = await temporaryDirectory("inspection-invalid-lifecycle")
    const approvalRoot = await temporaryDirectory("inspection-approval")
    await mkdir(path.join(workarea, "raw", "operations"), { recursive: true })
    await Bun.write(
      path.join(workarea, "raw", "operations", "run-state.json"),
      JSON.stringify({
        version: 2,
        workflow: "pentest",
        phase: "report",
        attempt: 1,
        status: "running",
        mode: "work",
        deadline_at: "2026-08-24T12:10:00.000Z",
        budget_remaining_ms: 1,
        closeout_reserve_ms: 1,
        closeout_remaining_ms: 1,
        last_progress_at: "2026-08-24T12:00:00.000Z",
        updated_at: "invalid-timestamp-secret",
        actors: [],
        recoveries: [],
        steering: [],
      }),
    )

    const snapshot = await buildSessionInspection({
      session: session(),
      messages: [],
      workarea: { root: workarea, name: "inspection-invalid-lifecycle" },
      approvalRoot,
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    })

    expect(snapshot.lifecycle).toBeUndefined()
    expect(snapshot.diagnostics).toContainEqual({
      component: "lifecycle",
      code: "not-available",
      message: "The lifecycle data is missing, invalid, or unavailable.",
    })
    expect(JSON.stringify(snapshot)).not.toContain("invalid-timestamp-secret")
  })
})
