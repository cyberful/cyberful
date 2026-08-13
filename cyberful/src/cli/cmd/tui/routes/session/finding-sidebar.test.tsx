// ── Finding Sidebar Projection Tests ─────────────────────────────
// Verifies historical-first grouping and the rendered 2/3 + 1/3 terminal split.
// → cyberful/src/cli/cmd/tui/routes/session/finding-sidebar.tsx — owns the projection.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { FindingRegistryView, SessionHypothesisRegistryView } from "@/server/client"
import {
  activeHypothesisLabel,
  findingDialogHeight,
  findingGroups,
  findingRewardSummary,
  findingSeverityTone,
  findingSplitWidths,
  findingTag,
  sidebarContentKinds,
} from "./finding-sidebar"

const view: FindingRegistryView = {
  workarea: "target",
  runID: "ses_current",
  registry: {
    schema_version: 1,
    revision: 3,
    runs: [
      { id: "ses_old", workflow: "bug-bounty", startedAt: "2026-01-01T00:00:00.000Z", status: "COMPLETED" },
      { id: "ses_current", workflow: "bug-bounty", startedAt: "2026-01-02T00:00:00.000Z", status: "RUNNING" },
    ],
    findings: [
      {
        id: "fnd_old",
        aliases: ["BBP-001"],
        title: "Historical",
        origin: { workflow: "bug-bounty", source: "finding" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        observations: [
          {
            id: "obs_old",
            runID: "ses_old",
            phase: "verify",
            timestamp: "2026-01-01T00:00:00.000Z",
            review: "ASSESSED",
            disposition: { state: "CONFIRMED", proof: "Old proof." },
            severity: "HIGH",
            verification: { result: "SURVIVES", rationale: "Verified in the old run." },
            submission: { result: "SUBMISSION_READY", rationale: "Ready in the old run." },
            summary: "Old confirmation.",
            evidencePaths: [],
            maturation: {
              assessment: {
                status: "MAXIMIZED",
                currentImpact: "Cross-tenant account access.",
                conclusion: "The independent proof supports HIGH.",
              },
              checkpoint: {
                id: "mat_old",
                signature: "signature",
                promptedAt: "2026-01-01T00:00:00.000Z",
                questions: ["What is the strongest impact currently supported by the evidence?"],
                reward: {
                  policyRevision: "reward-r1",
                  policyKind: "MONETARY",
                  groupID: "web",
                  current: { severity: "HIGH", minimum: 3_000, maximum: 5_000, unit: "MONEY", currency: "USD" },
                  target: { severity: "CRITICAL", minimum: 8_000, maximum: 10_000, unit: "MONEY", currency: "USD" },
                  upside: { minimum: 3_000, maximum: 7_000, unit: "MONEY", currency: "USD" },
                },
              },
            },
          },
        ],
      },
      {
        id: "fnd_review",
        aliases: ["BBP-002"],
        title: "Revisited",
        origin: { workflow: "bug-bounty", source: "finding" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        observations: [
          {
            id: "obs_review",
            runID: "ses_current",
            phase: "recon",
            timestamp: "2026-01-02T00:00:00.000Z",
            review: "IN_REVIEW",
            plan: "Re-test.",
            carriedState: "SUSPECTED",
            severity: "MEDIUM",
            verification: { result: "NOT_REVIEWED" },
            submission: { result: "NOT_ASSESSED" },
            summary: "Revisit started.",
            evidencePaths: [],
          },
        ],
      },
    ],
  },
}

const hypothesisView: SessionHypothesisRegistryView = {
  revision: 4,
  workflow: "bug-bounty",
  activeCount: 1,
  countsByState: {
    OPEN: 1,
    QUEUED: 0,
    TESTING: 0,
    SUSPECTED: 0,
    CONFIRMED: 0,
    DISPROVED: 1,
    INCONCLUSIVE: 0,
    UNTESTABLE: 0,
  },
  activeHypotheses: [
    {
      id: "H-AUTH-1",
      phase: "recon",
      owner: "recon-root",
      description: "A cross-tenant object read may bypass ownership checks",
      rootCause: "The object lookup may omit the tenant predicate",
      surface: "Project API",
      discriminator: "Compare owner and non-owner reads of one synthetic object",
      candidateTools: ["browser_request"],
      omittedTools: [],
      state: "OPEN",
      evidence: [],
      evidenceRefs: [],
      graphRefs: [],
      transitions: [
        {
          time: "2026-01-02T00:00:00.000Z",
          phase: "recon",
          owner: "recon-root",
          to: "OPEN",
          evidence: [],
        },
      ],
    },
  ],
}

test("findings are grouped globally by descending severity", () => {
  const groups = findingGroups(view)
  expect(groups.map((item) => item.group)).toEqual(["HIGH · 1", "MEDIUM · 1"])
  expect(groups[0]?.findings[0]?.historical).toBe(true)
  expect(groups[1]?.findings[0]?.historical).toBe(false)
  expect(findingTag("NEEDS_MORE_EVIDENCE")).toBe("[NEEDS MORE EVIDENCE]")
  expect(["error", "warning", "accent", "info", "textMuted"]).toEqual(
    (["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const).map(findingSeverityTone),
  )
})

test("active hypothesis copy is absent at zero and handles singular and plural", () => {
  expect(activeHypothesisLabel(0)).toBeUndefined()
  expect(activeHypothesisLabel(1)).toBe("(i) 1 active hypothesis")
  expect(activeHypothesisLabel(12)).toBe("(i) 12 active hypotheses")
})

test("findings stay above active hypotheses and the hypothesis block remains visible without findings", () => {
  expect(sidebarContentKinds(undefined, hypothesisView)).toEqual(["hypotheses"])
  expect(sidebarContentKinds(view, hypothesisView)).toEqual(["findings", "hypotheses"])
  expect(sidebarContentKinds(view, undefined)).toEqual(["findings"])
})

test("Bug Bounty reward previews retain current, target, and conservative upside", () => {
  const maturation = view.registry.findings[0]?.observations[0]?.maturation
  expect(findingRewardSummary(maturation)).toBe("USD 3000–5000 → USD 8000–10000 · +USD 3000–7000")
})

test("OpenTUI renders the feed at 2/3 and the divider-owned sidebar at 1/3", async () => {
  const widths = findingSplitWidths(99, true)
  const rendered = await testRender(
    () => (
      <box width={99} height={4} flexDirection="row">
        <box id="finding-feed" width={widths.feed} />
        <box id="finding-sidebar" width={widths.sidebar} border={["left"]} />
      </box>
    ),
    { width: 99, height: 4 },
  )

  try {
    await rendered.renderOnce()
    expect(rendered.renderer.root.findDescendantById("finding-feed")?.width).toBe(66)
    expect(rendered.renderer.root.findDescendantById("finding-sidebar")?.width).toBe(33)
  } finally {
    rendered.renderer.destroy()
  }
})

test("finding details stay centered inside a bounded terminal-height modal", () => {
  expect(findingDialogHeight(40)).toBe(28)
  expect(findingDialogHeight(12)).toBeLessThanOrEqual(10)
  expect(findingDialogHeight(4)).toBe(4)
})

test("OpenTUI clips a three-line finding preview to the sidebar content width", async () => {
  const rendered = await testRender(
    () => (
      <box id="sidebar" width={40} height={8} overflow="hidden">
        <scrollbox width="100%">
          <box id="finding-row" width="100%" overflow="hidden">
            <text id="finding-title" width="100%" height={3} overflow="hidden" wrapMode="word">
              SOURCE-CAND-001 A deliberately long finding title that must not cross the sidebar boundary
            </text>
          </box>
        </scrollbox>
      </box>
    ),
    { width: 80, height: 8 },
  )

  try {
    await rendered.renderOnce()
    const sidebar = rendered.renderer.root.findDescendantById("sidebar")
    const row = rendered.renderer.root.findDescendantById("finding-row")
    const title = rendered.renderer.root.findDescendantById("finding-title")
    expect(sidebar?.width).toBe(40)
    expect(row?.width).toBeLessThanOrEqual(40)
    expect(title?.width).toBeLessThanOrEqual(40)
    expect(title?.height).toBe(3)
  } finally {
    rendered.renderer.destroy()
  }
})
