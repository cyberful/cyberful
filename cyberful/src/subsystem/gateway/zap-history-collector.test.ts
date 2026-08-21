// ── Incremental ZAP History Collector Tests ─────────────────────
// Verifies metadata-only pagination, durable resume, scope partitioning,
//   redaction, response presence, duplicate tolerance, and fail-open degradation.
// → cyberful/src/subsystem/gateway/zap-history-collector.ts — owns cursoring.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { EngagementPolicy } from "./engagement-policy"
import { SurfaceCoverage } from "./surface-coverage"
import { ZapHistoryCollector } from "./zap-history-collector"

const policy: EngagementPolicy = {
  version: 1,
  stage: "final",
  updated_at: "2026-08-20T00:00:00.000Z",
  profiles: [],
  authorized_http_hosts: ["app.example.test", "*.api.example.test"],
  global_http_rps: null,
  required_http_headers: [],
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }
}

function message(id: number, url = `https://app.example.test/orders/${id}?token=secret`) {
  return {
    id,
    method: "GET",
    url,
    status_code: 200,
    response_header_bytes: 20,
    requestHeader: "Authorization: secret",
    requestBody: "password=secret",
    cookie: "secret",
  }
}

describe("ZAP history collector", () => {
  test("pages in bounded batches, redacts URLs, partitions dependencies, and persists resume cursor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zap-coverage-"))
    try {
      const calls: Record<string, unknown>[] = []
      const firstCoverage = new SurfaceCoverage(root, "recon")
      const first = new ZapHistoryCollector(root, firstCoverage, async (args) => {
        calls.push(args)
        if (args.start === 0) return result({ messages: Array.from({ length: 100 }, (_, index) => message(index)), returned: 100 })
        return result({
          messages: [
            message(100, "https://cdn.vendor.test/assets/app.js?session=secret"),
            {
              id: 101,
              method: "POST",
              url: "https://v1.api.example.test/jobs/550e8400-e29b-41d4-a716-446655440000?key=secret",
              response_header_bytes: 0,
              response_body_bytes: 0,
            },
          ],
          returned: 2,
        })
      })
      await first.sync(policy)
      await firstCoverage.close()
      expect(calls).toEqual([
        { start: 0, count: 100, include_bodies: false },
        { start: 100, count: 100, include_bodies: false },
      ])
      expect(JSON.parse(await readFile(path.join(root, "raw/operations/zap-history-coverage.cursor.json"), "utf8"))).toEqual({
        version: 1,
        next_start: 102,
      })
      const ledger = await readFile(path.join(root, "raw/operations/surface-coverage.jsonl"), "utf8")
      expect(ledger).not.toContain("secret")
      expect(ledger).not.toContain("Authorization")
      expect(ledger).not.toContain("requestBody")
      expect(ledger).not.toContain("cookie")
      const recon = JSON.parse(
        await readFile(path.join(root, "raw/operations/surface-coverage/recon.summary.json"), "utf8"),
      )
      expect(recon.http_route_families).toContain("https://app.example.test/orders/:id")
      expect(recon.http_route_families).toContain("https://v1.api.example.test/jobs/:id")
      expect(recon.passive_dependencies).toContainEqual({
        origin: "https://cdn.vendor.test",
        path_family: "/assets/app.js",
        zap_ids: ["100"],
        methods: ["GET"],
        http_statuses: [200],
        responses_present: true,
      })
      expect(recon.failed_only).toContain("https://v1.api.example.test/jobs/:id")

      const resumeCalls: Record<string, unknown>[] = []
      const secondCoverage = new SurfaceCoverage(root, "exploit")
      const second = new ZapHistoryCollector(root, secondCoverage, async (args) => {
        resumeCalls.push(args)
        return result({ messages: [message(102, "https://app.example.test/settings")], returned: 1 })
      })
      await second.sync(policy)
      expect(resumeCalls).toEqual([{ start: 102, count: 100, include_bodies: false }])
      const exploit = JSON.parse(
        await readFile(path.join(root, "raw/operations/surface-coverage/exploit.summary.json"), "utf8"),
      )
      expect(exploit.http_route_families).toEqual(["https://app.example.test/settings"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("shrinks an oversized page without moving the durable cursor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zap-coverage-adaptive-"))
    try {
      const calls: Record<string, unknown>[] = []
      const coverage = new SurfaceCoverage(root, "recon")
      const collector = new ZapHistoryCollector(root, coverage, async (args) => {
        calls.push(args)
        if (args.count === 100)
          return { content: [{ type: "text", text: "ZAP API core:view:messages exceeded the 25000000-byte response limit" }], isError: true }
        return result({ messages: [message(0)], returned: 1 })
      })
      await collector.sync(policy)
      expect(calls).toEqual([
        { start: 0, count: 100, include_bodies: false },
        { start: 0, count: 50, include_bodies: false },
      ])
      expect(JSON.parse(await readFile(path.join(root, "raw/operations/zap-history-coverage.cursor.json"), "utf8"))).toEqual({
        version: 1,
        next_start: 1,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("keeps the safe page size for the remainder of an oversized history sync", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zap-coverage-adaptive-sticky-"))
    try {
      const calls: Record<string, unknown>[] = []
      const coverage = new SurfaceCoverage(root, "recon")
      const collector = new ZapHistoryCollector(root, coverage, async (args) => {
        calls.push(args)
        if (args.count === 100)
          return { content: [{ type: "text", text: "exceeded the 25000000-byte response limit" }], isError: true }
        const start = Number(args.start)
        const count = start < 100 ? 50 : 1
        return result({ messages: Array.from({ length: count }, (_, index) => message(start + index)), returned: count })
      })
      await collector.sync(policy)
      expect(calls.map(({ start, count }) => ({ start, count }))).toEqual([
        { start: 0, count: 100 },
        { start: 0, count: 50 },
        { start: 50, count: 50 },
        { start: 100, count: 50 },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("degrades rather than skipping history when pagination metadata is inconsistent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zap-coverage-pagination-"))
    try {
      const coverage = new SurfaceCoverage(root, "recon")
      const collector = new ZapHistoryCollector(root, coverage, async () =>
        result({ messages: [message(0)], returned: 50 }),
      )
      await collector.sync(policy)
      const summary = JSON.parse(
        await readFile(path.join(root, "raw/operations/surface-coverage/recon.summary.json"), "utf8"),
      )
      expect(summary.collector).toMatchObject({
        degraded: true,
        failure_code: "ZAP_HISTORY_INVALID_PROJECTION",
        cursor: 0,
      })
      expect(summary.http_surface).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("deduplicates replayed crash records in set-based summaries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zap-coverage-duplicates-"))
    try {
      const coverage = new SurfaceCoverage(root, "recon")
      const collector = new ZapHistoryCollector(root, coverage, async () =>
        result({ messages: [message(1), message(1), message(2)], returned: 3 }),
      )
      await collector.sync(policy)
      const summary = JSON.parse(
        await readFile(path.join(root, "raw/operations/surface-coverage/recon.summary.json"), "utf8"),
      )
      expect(summary.http_surface).toEqual([
        {
          origin: "https://app.example.test",
          path_family: "/orders/:id",
          zap_ids: ["1", "2"],
          methods: ["GET"],
          http_statuses: [200],
          responses_present: true,
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("degrades coverage without throwing when history collection fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zap-coverage-degraded-"))
    try {
      const coverage = new SurfaceCoverage(root, "recon")
      const failures: string[] = []
      const collector = new ZapHistoryCollector(
        root,
        coverage,
        async () => {
          throw new Error("ZAP unavailable")
        },
        async (error) => {
          failures.push(error instanceof Error ? error.message : String(error))
        },
      )
      await expect(collector.sync(policy)).resolves.toBeUndefined()
      expect(failures).toEqual(["ZAP unavailable"])
      const summary = JSON.parse(
        await readFile(path.join(root, "raw/operations/surface-coverage/recon.summary.json"), "utf8"),
      )
      expect(summary.collector).toEqual({
        source: "zap_history",
        degraded: true,
        failure_code: "ZAP_HISTORY_TRANSPORT_FAILED",
        cursor: 0,
      })
      expect(await coverage.researchCloseoutAssessment(policy)).toMatchObject({ collectorDegraded: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not classify a metadata projection error as a transport outage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zap-coverage-tool-error-"))
    try {
      const coverage = new SurfaceCoverage(root, "recon")
      let transportFailures = 0
      const collector = new ZapHistoryCollector(
        root,
        coverage,
        async () => ({ content: [{ type: "text", text: "history rejected" }], isError: true }),
        async () => {
          transportFailures++
        },
      )
      await expect(collector.sync(policy)).resolves.toBeUndefined()
      expect(transportFailures).toBe(0)
      expect(await coverage.researchCloseoutAssessment(policy)).toMatchObject({ collectorDegraded: true })
      const summary = JSON.parse(
        await readFile(path.join(root, "raw/operations/surface-coverage/recon.summary.json"), "utf8"),
      )
      expect(summary.collector.failure_code).toBe("ZAP_HISTORY_TOOL_ERROR")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
