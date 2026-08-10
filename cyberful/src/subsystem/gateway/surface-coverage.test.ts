// ── Passive Surface Coverage Tests ──────────────────────────────
// Verifies redacted metadata, durable phase summaries, and inherited Brief
//   coverage used by the Recon handoff guard.
// → cyberful/src/subsystem/gateway/surface-coverage.ts — owns the ledger.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { BrowserProfileId } from "@/dependency/browser-profile"
import { SurfaceCoverage, browserAction } from "./surface-coverage"

function result(
  action: string,
  family: string,
  route: string,
  outcome: "ok" | "error" = "ok",
  profile: BrowserProfileId = 2,
) {
  return {
    content: [{ type: "text" as const, text: "ok" }],
    _meta: {
      "cyberful.dev/browser-action": {
        profile,
        page_id: profile === "search" ? "search-page" : "page-1",
        origin: profile === "search" ? "https://html.duckduckgo.com" : "https://example.test",
        path_family: route,
        action,
        action_family: family,
        page_transition: "same_origin",
        outcome,
        status: 200,
      },
    },
  }
}

describe("surface coverage", () => {
  test("persists only redacted action dimensions and summarizes exercised routes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "surface-coverage-"))
    try {
      const coverage = new SurfaceCoverage(root, "recon")
      await coverage.observe(result("browser_snapshot", "observation", "/settings/:id"))
      await coverage.observe(
        result("browser_click", "ui_interaction", "/trade"),
        {
          egress_host: "api.example.test",
          egress_method: "PUT",
          egress_http_status: 201,
          egress_path_family: "/orders/:id",
          egress_route: "browser/zap",
        },
      )
      await coverage.observe(result("browser_click", "ui_interaction", "/admin", "error"))
      await coverage.observe(
        { content: [{ type: "text", text: "replayed" }] },
        {
          egress_host: "api.example.test",
          egress_method: "POST",
          egress_http_status: 403,
          egress_path_family: "/kms/decrypt",
          egress_route: "zap",
        },
      )
      await coverage.observe(
        { content: [{ type: "text", text: "failed" }], isError: true },
        {
          egress_host: "api.example.test",
          egress_method: "DELETE",
          egress_path_family: "/mixed/:id",
          egress_route: "zap",
        },
      )
      await coverage.observe(
        { content: [{ type: "text", text: "recovered" }] },
        {
          egress_host: "api.example.test",
          egress_method: "GET",
          egress_http_status: 200,
          egress_path_family: "/mixed/:id",
          egress_route: "zap",
        },
      )
      await coverage.close()
      expect(browserAction(result("browser_click", "ui_interaction", "/trade"))).toMatchObject({ profile: 2 })
      const ledger = await readFile(path.join(root, "raw/operations/surface-coverage.jsonl"), "utf8")
      expect(ledger).not.toContain("selector")
      expect(ledger).not.toContain("cookie")
      const summary = JSON.parse(
        await readFile(path.join(root, "raw/operations/surface-coverage/recon.summary.json"), "utf8"),
      )
      expect(summary.route_families).toEqual([
        "https://example.test/admin",
        "https://example.test/settings/:id",
        "https://example.test/trade",
        "network://api.example.test/kms/decrypt",
        "network://api.example.test/mixed/:id",
        "network://api.example.test/orders/:id",
      ])
      expect(summary.observed_not_exercised).toEqual(["https://example.test/settings/:id"])
      expect(summary.failed_only).toEqual(["https://example.test/admin"])
      expect(summary.blocked_or_failed).toBeUndefined()
      expect(summary.methods_observed).toEqual(["DELETE", "GET", "POST", "PUT"])
      expect(summary.http_statuses_observed).toEqual([200, 201, 403])
      expect(summary.surface_details).toContainEqual({
        origin: "network://api.example.test",
        path_family: "/mixed/:id",
        methods: ["DELETE", "GET"],
        http_statuses: [200],
        outcomes: ["error", "ok"],
      })
      expect(summary.per_profile).toEqual([
        {
          profile: 2,
          origins: ["https://example.test"],
          route_families: [
            "https://example.test/admin",
            "https://example.test/settings/:id",
            "https://example.test/trade",
          ],
          meaningful_actions: 2,
          meaningful_origins: ["https://example.test"],
          errors: 1,
        },
      ])
      expect(
        await coverage.handoffError({
          version: 1,
          updated_at: new Date().toISOString(),
          profiles: [
            { profile: 2, readiness: "READY", scope: "IN_SCOPE", origin: "https://example.test" },
            { profile: 3, readiness: "READY", scope: "IN_SCOPE", origin: "https://example.test" },
          ],
          authorized_http_hosts: ["example.test"],
          global_http_rps: null,
        }),
      ).toContain("3")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("allows local-only Recon after Brief meaningfully reached the same ready profile origin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "surface-coverage-"))
    try {
      const brief = new SurfaceCoverage(root, "brief")
      await brief.observe(result("browser_navigate", "navigation", "/policy"))
      await brief.close()

      const recon = new SurfaceCoverage(root, "recon")
      const policy = {
        version: 1 as const,
        updated_at: new Date().toISOString(),
        profiles: [{ profile: 2, readiness: "READY" as const, scope: "IN_SCOPE" as const, origin: "https://example.test" }],
        authorized_http_hosts: ["example.test"],
        global_http_rps: null,
      }
      expect(await recon.handoffError(policy)).toBeUndefined()

      const otherOrigin = { ...policy, profiles: [{ ...policy.profiles[0]!, origin: "https://other.test" }] }
      expect(await recon.handoffError(otherOrigin)).toContain("2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not inherit observation-only Brief coverage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "surface-coverage-"))
    try {
      const brief = new SurfaceCoverage(root, "brief")
      await brief.observe(result("browser_snapshot", "observation", "/policy"))
      await brief.close()

      const recon = new SurfaceCoverage(root, "recon")
      expect(
        await recon.handoffError({
          version: 1,
          updated_at: new Date().toISOString(),
          profiles: [{ profile: 2, readiness: "READY", scope: "IN_SCOPE", origin: "https://example.test" }],
          authorized_http_hosts: ["example.test"],
          global_http_rps: null,
        }),
      ).toContain("2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("keeps search scope in memory for CAPTCHA while excluding it from target evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "surface-coverage-search-"))
    try {
      const coverage = new SurfaceCoverage(root, "recon")
      await coverage.observe(result("browser_navigate", "navigation", "/target"))
      await coverage.observe(result("web_search", "web_research", "/html", "ok", "search"), {
        egress_host: "html.duckduckgo.com",
        egress_method: "GET",
        egress_http_status: 200,
        egress_path_family: "/html",
        egress_route: "browser/direct-search",
      })
      await coverage.observe({ content: [{ type: "text", text: "malformed upstream metadata" }] }, {
        egress_host: "html.duckduckgo.com",
        egress_method: "GET",
        egress_path_family: "/html",
        egress_route: "browser/direct-search",
      })
      expect(coverage.currentScope("search")).toEqual({
        profile: "search",
        pageID: "search-page",
        origin: "https://html.duckduckgo.com",
      })
      await coverage.close()

      const ledger = await readFile(path.join(root, "raw/operations/surface-coverage.jsonl"), "utf8")
      expect(ledger).not.toContain("search")
      expect(ledger).not.toContain("duckduckgo")
      expect(ledger).not.toContain("direct-search")
      const summary = JSON.parse(
        await readFile(path.join(root, "raw/operations/surface-coverage/recon.summary.json"), "utf8"),
      )
      expect(summary.route_families).toEqual(["https://example.test/target"])
      expect(summary.per_profile.map((entry: { profile: number }) => entry.profile)).toEqual([2])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
