// ── Host-Owned Passive ZAP Evidence Tests ───────────────────────
// Verifies deterministic scope selection, bounded queue waits, filtered report
//   publication, and best-effort failure states without a live ZAP daemon.
// → cyberful/src/subsystem/zap/passive-evidence.ts — owns the checkpoint.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  authorizedObservedOrigins,
  capturePassiveEvidence,
  type PassiveEvidenceSource,
} from "./passive-evidence"

async function workarea(hosts: readonly string[]) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-passive-evidence-")))
  await mkdir(path.join(root, "raw/policy"), { recursive: true })
  await writeFile(
    path.join(root, "raw/policy/engagement.json"),
    `${JSON.stringify({
      version: 1,
      stage: "final",
      updated_at: "2026-08-20T00:00:00.000Z",
      profiles: [],
      authorized_http_hosts: hosts,
      global_http_rps: null,
      required_http_headers: [],
    })}\n`,
  )
  return root
}

function source(input: {
  sites?: readonly string[]
  depths?: readonly number[]
  failReportAt?: number
  reportInsights?: readonly { readonly site: string; readonly key: string }[]
}) {
  let queueIndex = 0
  let queueCalls = 0
  let reportIndex = 0
  const reports: string[][] = []
  const value: PassiveEvidenceSource = {
    sites: async () => input.sites ?? [],
    queueDepth: async () => {
      queueCalls += 1
      return input.depths?.[Math.min(queueIndex++, (input.depths?.length ?? 1) - 1)] ?? 0
    },
    generateReport: async ({ filePath, sites }) => {
      reportIndex += 1
      if (input.failReportAt === reportIndex) throw new Error("synthetic report failure")
      reports.push([...sites])
      const target = path.join(activeWorkarea, filePath)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, JSON.stringify({
        insights: input.reportInsights,
        site: sites.map((site) => ({ "@name": site, alerts: [] })),
      }))
    },
    close: async () => {},
  }
  return { value, reports, queueCalls: () => queueCalls }
}

let activeWorkarea = ""

async function manifest(root: string, workflow = "pentest", phase = "recon") {
  return JSON.parse(await readFile(path.join(root, `raw/zap/passive/${workflow}/${phase}.json`), "utf8"))
}

describe("passive ZAP evidence", () => {
  test("normalizes only authorized HTTP(S) origins without port, path, query, or userinfo scope expansion", () => {
    expect(
      authorizedObservedOrigins(
        [
          "https://user:secret@app.example.test:8443/path?q=1",
          "https://v1.api.example.test/path",
          "https://api.example.test/apex",
          "ftp://app.example.test/file",
          "https://outside.example/path",
        ],
        ["app.example.test", "*.api.example.test"],
      ),
    ).toEqual(["https://app.example.test:8443", "https://v1.api.example.test"])
  })

  test("writes not_applicable without opening ZAP when HTTP scope is empty", async () => {
    activeWorkarea = await workarea([])
    let opened = 0
    try {
      const result = await capturePassiveEvidence(
        { workarea: activeWorkarea, workflow: "pentest", phase: "brief", attempt: 1 },
        {
          openSource: async () => {
            opened += 1
            return source({}).value
          },
        },
      )
      expect(result.state).toBe("not_applicable")
      expect(opened).toBe(0)
      expect(await manifest(activeWorkarea, "pentest", "brief")).toMatchObject({ state: "not_applicable" })
    } finally {
      await rm(activeWorkarea, { recursive: true, force: true })
    }
  })

  test("reads the site tree once and does not wait or report when no authorized traffic was observed", async () => {
    activeWorkarea = await workarea(["app.example.test"])
    let waits = 0
    const fake = source({ sites: ["https://outside.example/path"] })
    try {
      const result = await capturePassiveEvidence(
        { workarea: activeWorkarea, workflow: "pentest", phase: "recon", attempt: 1 },
        {
          openSource: async () => fake.value,
          sleep: async () => {
            waits += 1
          },
        },
      )
      expect(result.state).toBe("no_observed_traffic")
      expect(fake.queueCalls()).toBe(0)
      expect(waits).toBe(0)
      expect(fake.reports).toEqual([])
    } finally {
      await rm(activeWorkarea, { recursive: true, force: true })
    }
  })

  test("publishes complete content-addressed evidence after the queue drains", async () => {
    activeWorkarea = await workarea(["app.example.test"])
    const fake = source({
      sites: ["https://app.example.test/path"],
      depths: [2, 1, 0],
      reportInsights: [
        { site: "https://app.example.test", key: "included" },
        { site: "https://outside.example", key: "excluded" },
        { site: "", key: "global" },
      ],
    })
    try {
      const result = await capturePassiveEvidence(
        { workarea: activeWorkarea, workflow: "bug-bounty", phase: "verify", attempt: 2 },
        { openSource: async () => fake.value, sleep: async () => {} },
      )
      expect(result).toMatchObject({ state: "complete", manifest: "raw/zap/passive/bug-bounty/verify.json" })
      const saved = await manifest(activeWorkarea, "bug-bounty", "verify")
      expect(saved).toMatchObject({
        state: "complete",
        attempt: 2,
        observed_origins: ["https://app.example.test"],
        queue: { initial: 2, final: 0, waited_ms: 1_000, drained: true },
      })
      expect(saved.reports).toHaveLength(1)
      const object = await readFile(path.join(activeWorkarea, saved.reports[0].path))
      expect(createHash("sha256").update(object).digest("hex")).toBe(saved.reports[0].sha256)
      expect(JSON.parse(object.toString("utf8")).insights).toEqual([
        { site: "https://app.example.test", key: "included" },
        { site: "", key: "global" },
      ])
    } finally {
      await rm(activeWorkarea, { recursive: true, force: true })
    }
  })

  test("classifies a ten-second queue timeout as partial while retaining reports", async () => {
    activeWorkarea = await workarea(["app.example.test"])
    const fake = source({ sites: ["https://app.example.test"], depths: [1] })
    try {
      const result = await capturePassiveEvidence(
        { workarea: activeWorkarea, workflow: "pentest", phase: "exploit", attempt: 1 },
        { openSource: async () => fake.value, sleep: async () => {} },
      )
      expect(result.state).toBe("partial")
      expect(result.warning).toContain("phase advancement is unchanged")
      expect(await manifest(activeWorkarea, "pentest", "exploit")).toMatchObject({
        state: "partial",
        queue: { final: 1, waited_ms: 10_000, drained: false },
      })
    } finally {
      await rm(activeWorkarea, { recursive: true, force: true })
    }
  })

  test("batches more than one hundred authorized origins into separate reports", async () => {
    activeWorkarea = await workarea(["*.example.test"])
    const sites = Array.from({ length: 101 }, (_, index) => `https://${index}.example.test/path`)
    const fake = source({ sites, depths: [0] })
    try {
      const result = await capturePassiveEvidence(
        { workarea: activeWorkarea, workflow: "pentest", phase: "recon", attempt: 1 },
        { openSource: async () => fake.value },
      )
      expect(result.state).toBe("complete")
      expect(fake.reports.map((batch) => batch.length)).toEqual([100, 1])
      expect((await manifest(activeWorkarea)).reports).toHaveLength(2)
    } finally {
      await rm(activeWorkarea, { recursive: true, force: true })
    }
  })

  test("classifies unavailable ZAP and unpublishable reports as failed", async () => {
    activeWorkarea = await workarea(["app.example.test"])
    try {
      const unavailable = await capturePassiveEvidence(
        { workarea: activeWorkarea, workflow: "pentest", phase: "recon", attempt: 1 },
        { openSource: async () => { throw new Error("ZAP unavailable") } },
      )
      expect(unavailable.state).toBe("failed")
      expect(unavailable.warning).toContain("phase advancement is unchanged")

      const fake = source({ sites: ["https://app.example.test"], depths: [0], failReportAt: 1 })
      const reportFailure = await capturePassiveEvidence(
        { workarea: activeWorkarea, workflow: "pentest", phase: "verify", attempt: 1 },
        { openSource: async () => fake.value },
      )
      expect(reportFailure.state).toBe("failed")
      expect(await manifest(activeWorkarea, "pentest", "verify")).toMatchObject({ state: "failed", reports: [] })
    } finally {
      await rm(activeWorkarea, { recursive: true, force: true })
    }
  })

  test("classifies manifest storage failure as failed without opening ZAP for empty HTTP scope", async () => {
    activeWorkarea = await workarea([])
    await writeFile(path.join(activeWorkarea, "raw/zap"), "blocks passive directory creation")
    let opened = 0
    try {
      const result = await capturePassiveEvidence(
        { workarea: activeWorkarea, workflow: "pentest", phase: "brief", attempt: 1 },
        {
          openSource: async () => {
            opened += 1
            return source({}).value
          },
        },
      )
      expect(result.state).toBe("failed")
      expect(result.warning).toContain("storage failed")
      expect(opened).toBe(0)
    } finally {
      await rm(activeWorkarea, { recursive: true, force: true })
    }
  })
})
