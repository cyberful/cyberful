// ── Passive Surface Coverage Tests ──────────────────────────────
// Verifies redacted metadata decoding and durable phase summaries.
// → cyberful/src/subsystem/gateway/surface-coverage.ts — owns the ledger.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SurfaceCoverage, browserAction } from "./surface-coverage"

function result(action: string, family: string, route: string, outcome: "ok" | "error" = "ok") {
  return {
    content: [{ type: "text" as const, text: "ok" }],
    _meta: {
      "cyberful.dev/browser-action": {
        profile: 2,
        page_id: "page-1",
        origin: "https://example.test",
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
      await coverage.observe(result("browser_click", "ui_interaction", "/trade"))
      await coverage.observe(result("browser_click", "ui_interaction", "/admin", "error"))
      await coverage.observe(
        { content: [{ type: "text", text: "replayed" }] },
        {
          egress_host: "api.example.test",
          egress_method: "POST",
          egress_path_family: "/kms/decrypt",
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
      ])
      expect(summary.observed_not_exercised).toEqual(["https://example.test/settings/:id"])
      expect(summary.blocked_or_failed).toEqual(["https://example.test/admin"])
      expect(summary.methods_observed).toEqual(["POST"])
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
})
