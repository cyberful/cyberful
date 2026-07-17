// ── ZAP Report Scope Contract ───────────────────────────────────────
// Verifies report names cannot escape the engagement workarea and requested
// site filters become canonical origins without credentials or path fragments.
// → mcps/zap/zap_report_path.mjs — owns report path and site normalization.
// ────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { engagementReportPath, engagementReportSites, withEngagementReportPath } from "./zap_report_path.mjs"

describe("ZAP report workarea paths", () => {
  test("maps absolute and relative report names to the engagement root", () => {
    expect(engagementReportPath("/zap/wrk/ZAP-NETWORK-SMOKE.json", "/zap/wrk")).toEqual({
      containerPath: "/zap/wrk/ZAP-NETWORK-SMOKE.json",
      engagementPath: "ZAP-NETWORK-SMOKE.json",
    })
    expect(engagementReportPath("reports/final.html", "/zap/wrk")).toEqual({
      containerPath: "/zap/wrk/reports/final.html",
      engagementPath: "reports/final.html",
    })
  })

  test("rejects the engagement root itself and every path outside it", () => {
    expect(() => engagementReportPath("/zap/wrk", "/zap/wrk")).toThrow("report filename")
    expect(() => engagementReportPath("../outside.json", "/zap/wrk")).toThrow("inside the engagement workarea")
    expect(() => engagementReportPath("/tmp/outside.json", "/zap/wrk")).toThrow("inside the engagement workarea")
  })

  test("preserves the official result and identifies the engagement-root artifact", () => {
    const result = withEngagementReportPath(
      { content: [{ type: "text", text: "Report generated" }] },
      engagementReportPath("report.json", "/zap/wrk"),
    )
    expect(result.content).toEqual([
      { type: "text", text: "Report generated" },
      {
        type: "text",
        text: JSON.stringify({
          engagement_root_relative_path: "report.json",
          container_path: "/zap/wrk/report.json",
        }),
      },
    ])
  })

  test("canonicalizes and deduplicates explicitly authorized report origins", () => {
    expect(
      engagementReportSites(["https://example.com/", "https://example.com:443", "http://example.com:80/"]),
    ).toEqual(["https://example.com", "http://example.com"])
  })

  test("rejects ambiguous or over-broad report sites", () => {
    expect(() => engagementReportSites([])).toThrow("at least one")
    expect(() => engagementReportSites(["example.com"])).toThrow("absolute HTTP(S) origins")
    expect(() => engagementReportSites(["ftp://example.com"])).toThrow("absolute HTTP(S) origins")
    expect(() => engagementReportSites(["https://u:p@example.com"])).toThrow("credentials")
    expect(() => engagementReportSites(["https://example.com/app"])).toThrow("origins")
    expect(() => engagementReportSites(["https://example.com/?q=1"])).toThrow("origins")
  })
})
