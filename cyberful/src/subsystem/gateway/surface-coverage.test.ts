// ── Passive Research Coverage Tests ─────────────────────────────
// Verifies the v3 separation between ZAP HTTP surface, semantic browser
//   activity, and direct egress, including current-phase Recon readiness.
// → cyberful/src/subsystem/gateway/surface-coverage.ts — owns the ledger.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { BrowserProfileId } from "@/dependency/browser-profile"
import type { EngagementPolicy } from "./engagement-policy"
import { browserActivity, SurfaceCoverage } from "./surface-coverage"

function result(
  _action: string,
  family: string,
  outcome: "ok" | "error" = "ok",
  profile: BrowserProfileId = 2,
  origin = "https://example.test",
) {
  return {
    content: [{ type: "text" as const, text: "upstream result may contain a typed value" }],
    _meta: {
      "cyberful.dev/browser-action": {
        profile,
        tab_id: profile === "search" ? "search-tab" : "opaque-tab",
        origin,
        action_family: family,
        outcome,
      },
    },
  }
}

function policy(profiles: EngagementPolicy["profiles"] = []): EngagementPolicy {
  return {
    version: 1,
    stage: "final",
    updated_at: new Date().toISOString(),
    profiles,
    authorized_http_hosts: ["example.test", "*.api.example.test"],
    global_http_rps: null,
    required_http_headers: [],
  }
}

describe("surface coverage", () => {
  test("persists separated v3 metadata without browser inputs or HTTP secrets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "surface-coverage-"))
    try {
      const coverage = new SurfaceCoverage(root, "recon")
      await coverage.observeBrowser(result("agent_browser_snapshot", "observation"))
      await coverage.observeBrowser(result("agent_browser_click", "ui_interaction"))
      await coverage.observeHttpSurface([
        {
          zapID: "7",
          origin: "https://example.test",
          pathFamily: "/orders/:id",
          method: "PUT",
          status: 201,
          hasResponse: true,
          inScope: true,
        },
        {
          zapID: "8",
          origin: "https://cdn.vendor.test",
          pathFamily: "/bundle.js",
          method: "GET",
          status: 200,
          hasResponse: true,
          inScope: false,
        },
        {
          zapID: "9",
          origin: "https://example.test",
          pathFamily: "/pending",
          method: "POST",
          hasResponse: false,
          inScope: true,
        },
      ])
      await coverage.observeDirectEgress(
        { content: [{ type: "text", text: "connected" }] },
        {
          egress_host: "db.example.test:5432",
          egress_path_family: "/postgres",
          egress_route: "cyberful-os/docker-direct",
        },
      )
      await coverage.close()

      expect(browserActivity(result("agent_browser_click", "ui_interaction"))).toMatchObject({
        profile: 2,
        tabID: "opaque-tab",
      })
      const ledger = await readFile(path.join(root, "raw/operations/surface-coverage.jsonl"), "utf8")
      expect(ledger).not.toContain("selector")
      expect(ledger).not.toContain("cookie")
      expect(ledger).not.toContain("typed value")
      expect(ledger).not.toContain("request_header")
      expect(ledger).toContain('"kind":"browser_activity"')
      expect(ledger).toContain('"kind":"http_surface"')
      expect(ledger).toContain('"kind":"passive_dependency"')
      expect(ledger).toContain('"kind":"direct_egress"')

      const summary = JSON.parse(
        await readFile(path.join(root, "raw/operations/surface-coverage/recon.summary.json"), "utf8"),
      )
      expect(summary.version).toBe(3)
      expect(summary.route_families).toEqual([
        "https://example.test/orders/:id",
        "https://example.test/pending",
      ])
      expect(summary.http_surface).toContainEqual({
        origin: "https://example.test",
        path_family: "/orders/:id",
        zap_ids: ["7"],
        methods: ["PUT"],
        http_statuses: [201],
        responses_present: true,
      })
      expect(summary.passive_dependencies).toEqual([
        {
          origin: "https://cdn.vendor.test",
          path_family: "/bundle.js",
          zap_ids: ["8"],
          methods: ["GET"],
          http_statuses: [200],
          responses_present: true,
        },
      ])
      expect(summary.failed_only).toEqual(["https://example.test/pending"])
      expect(summary.direct_egress[0]).toMatchObject({
        origin: "network://db.example.test:5432",
        path_family: "/postgres",
      })
      expect(summary.ui_action_family_counts).toEqual({ observation: 1, ui_interaction: 1 })
      expect(summary.per_profile[0]).toMatchObject({
        profile: 2,
        meaningful_actions: 1,
        meaningful_origins: ["https://example.test"],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("requires current-phase Recon activity for each READY and IN_SCOPE profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "surface-current-phase-"))
    try {
      const brief = new SurfaceCoverage(root, "brief")
      await brief.observeBrowser(result("agent_browser_open", "navigation"))
      await brief.close()

      const recon = new SurfaceCoverage(root, "recon")
      const engagement = policy([
        { profile: 2, readiness: "READY", scope: "IN_SCOPE", origin: "https://example.test" },
      ])
      expect(await recon.handoffError(engagement)).toContain("2")
      await recon.observeBrowser(result("agent_browser_snapshot", "observation"))
      expect(await recon.handoffError(engagement)).toContain("2")
      await recon.observeBrowser(result("agent_browser_click", "ui_interaction"))
      expect(await recon.handoffError(engagement)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not accept an unbound browser action for a READY profile without a configured origin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "surface-unbound-profile-"))
    try {
      const coverage = new SurfaceCoverage(root, "recon")
      const engagement = policy([{ profile: 2, readiness: "READY", scope: "IN_SCOPE" }])
      await coverage.observeBrowser(result("agent_browser_open", "navigation"))
      expect(await coverage.handoffError(engagement)).toContain("2")
      expect(await coverage.researchCloseoutAssessment(engagement)).toMatchObject({
        webTarget: false,
        unusedProfiles: [2],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("excludes the search profile while retaining its opaque scope in memory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "surface-search-"))
    try {
      const coverage = new SurfaceCoverage(root, "recon")
      await coverage.observeBrowser(
        result("agent_browser_open", "navigation", "ok", "search", "https://html.duckduckgo.com"),
        "search-run",
      )
      expect(coverage.currentScope("search-run", "search")).toEqual({
        ownerRunID: "search-run",
        profile: "search",
        tabID: "search-tab",
        origin: "https://html.duckduckgo.com",
      })
      await coverage.close()
      await expect(
        readFile(path.join(root, "raw/operations/surface-coverage.jsonl"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reads v2 predecessor summaries as coverage candidates without making them obligations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "surface-candidates-"))
    try {
      const summaryRoot = path.join(root, "raw/operations/surface-coverage")
      await mkdir(summaryRoot, { recursive: true })
      await writeFile(
        path.join(summaryRoot, "recon.summary.json"),
        JSON.stringify({
          version: 2,
          phase: "recon",
          route_families: [
            "https://example.test/accounts/:id",
            "network://db.example.test/postgres",
          ],
        }),
      )
      const exploit = new SurfaceCoverage(root, "exploit")
      const engagement = policy([
        { profile: 2, readiness: "READY", scope: "IN_SCOPE", origin: "https://example.test" },
      ])
      expect(await exploit.researchCloseoutAssessment(engagement)).toEqual({
        version: 1,
        webTarget: true,
        unusedProfiles: [2],
        coverageCandidateCount: 1,
        coverageCandidateSamples: ["https://example.test/accounts/:id"],
        collectorDegraded: false,
      })
      await exploit.observeHttpSurface([
        {
          zapID: "10",
          origin: "https://example.test",
          pathFamily: "/accounts/:id",
          method: "GET",
          status: 200,
          hasResponse: true,
          inScope: true,
        },
      ])
      await exploit.observeBrowser(result("agent_browser_open", "navigation"))
      expect(await exploit.researchCloseoutAssessment(engagement)).toMatchObject({
        unusedProfiles: [],
        coverageCandidateCount: 0,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rehydrates current-phase v3 records after phase recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "surface-recovery-"))
    try {
      const first = new SurfaceCoverage(root, "recon")
      await first.observeBrowser(result("agent_browser_click", "ui_interaction"))
      await first.observeHttpSurface([{
        zapID: "17",
        origin: "https://example.test",
        pathFamily: "/settings",
        method: "GET",
        status: 200,
        hasResponse: true,
        inScope: true,
      }])
      await first.setCollectorState("degraded")
      await first.close()

      const recovered = new SurfaceCoverage(root, "recon")
      const engagement = policy([
        { profile: 2, readiness: "READY", scope: "IN_SCOPE", origin: "https://example.test" },
      ])
      expect(await recovered.handoffError(engagement)).toBeUndefined()
      expect(await recovered.researchCloseoutAssessment(engagement)).toMatchObject({ collectorDegraded: true })
      await recovered.setCollectorState("ok")
      const summary = JSON.parse(
        await readFile(path.join(root, "raw/operations/surface-coverage/recon.summary.json"), "utf8"),
      )
      expect(summary.http_route_families).toEqual(["https://example.test/settings"])
      expect(summary.ui_action_family_counts).toEqual({ ui_interaction: 1 })
      expect(summary.collector.degraded).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
