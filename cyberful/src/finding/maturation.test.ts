// ── Finding Maturation Calculation Tests ────────────────────────
// Verifies reward-group selection, currency-safe upside, and workflow-specific
//   checkpoint bundles without invoking an additional model run.
// → cyberful/src/finding/maturation.ts — owns checkpoint calculation.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { FindingMaturation } from "./maturation"
import type { GatewayRewardPolicy } from "@/subsystem/gateway/reward-policy"

const source = { url: "https://security.example.test/program", observed_at: "2026-08-10T08:00:00.000Z" }

test("requires an explicit reward group when a program publishes several schedules", () => {
  const policy: GatewayRewardPolicy.RewardPolicy = {
    version: 1,
    revision: "reward-r1",
    updated_at: source.observed_at,
    kind: "MONETARY",
    source,
    groups: [
      {
        id: "web",
        label: "Web",
        assets: ["app.example.test"],
        tiers: [{ severity: "MEDIUM", minimum: 500, maximum: 1_000, currency: "USD" }],
      },
      {
        id: "mobile",
        label: "Mobile",
        assets: ["mobile.example.test"],
        tiers: [{ severity: "MEDIUM", minimum: 700, maximum: 1_200, currency: "USD" }],
      },
    ],
  }
  const advisory = FindingMaturation.buildAdvisory({
    workflow: "bug-bounty",
    phase: "exploit",
    toolInput: {
      action: "record",
      key: "BBP-001",
      severity: "MEDIUM",
    },
    policy,
  })

  expect(advisory?.checkpoint.reward).toMatchObject({ policyRevision: "reward-r1", policyKind: "MONETARY" })
  expect(advisory?.checkpoint.reward?.groupID).toBeUndefined()
  expect(advisory?.checkpoint.reward?.upside).toBeUndefined()
  expect(advisory?.checkpoint.questions.join(" ")).toContain("reward_group_id")
})

test("does not calculate monetary upside across different published currencies", () => {
  const advisory = FindingMaturation.buildAdvisory({
    workflow: "bug-bounty",
    phase: "exploit",
    toolInput: { action: "record", key: "BBP-002", severity: "MEDIUM" },
    policy: {
      version: 1,
      revision: "reward-r2",
      updated_at: source.observed_at,
      kind: "MONETARY",
      source,
      groups: [
        {
          id: "mixed",
          label: "Mixed",
          assets: ["app.example.test"],
          tiers: [
            { severity: "MEDIUM", minimum: 500, maximum: 1_000, currency: "USD" },
            { severity: "HIGH", minimum: 3_000, maximum: 5_000, currency: "EUR" },
          ],
        },
      ],
    },
  })

  expect(advisory?.checkpoint.reward?.current?.currency).toBe("USD")
  expect(advisory?.checkpoint.reward?.target?.currency).toBe("EUR")
  expect(advisory?.checkpoint.reward?.upside).toBeUndefined()
})

test("calculates point deltas but keeps Pentest free of reward context", () => {
  const points = FindingMaturation.buildAdvisory({
    workflow: "bug-bounty",
    phase: "hacker",
    toolInput: { action: "record", key: "BBP-003", severity: "LOW" },
    policy: {
      version: 1,
      revision: "reward-r3",
      updated_at: source.observed_at,
      kind: "POINTS",
      source,
      groups: [
        {
          id: "points",
          label: "Points",
          assets: ["app.example.test"],
          tiers: [
            { severity: "LOW", minimum: 10, maximum: 20 },
            { severity: "MEDIUM", minimum: 50, maximum: 80 },
          ],
        },
      ],
    },
  })
  const pentest = FindingMaturation.buildAdvisory({
    workflow: "pentest",
    phase: "hacker",
    toolInput: { action: "record", key: "PT-003", severity: "LOW" },
  })

  expect(points?.checkpoint.reward?.upside).toMatchObject({ minimum: 30, maximum: 70, unit: "POINTS" })
  expect(pentest?.checkpoint.questions).toHaveLength(3)
  expect(pentest?.checkpoint.reward).toBeUndefined()
})

test("does not present the current severity as a next reward tier", () => {
  const advisory = FindingMaturation.buildAdvisory({
    workflow: "bug-bounty",
    phase: "verify",
    toolInput: {
      action: "update",
      id: "BBP-004",
      severity: "MEDIUM",
      maturation: {
        status: "MAXIMIZED",
        current_impact: "A bounded client-side effect.",
        target_severity: "MEDIUM",
      },
    },
    policy: {
      version: 1,
      revision: "reward-r4",
      updated_at: source.observed_at,
      kind: "MONETARY",
      source,
      groups: [
        {
          id: "web",
          label: "Web",
          assets: ["app.example.test"],
          tiers: [{ severity: "MEDIUM", minimum: 1_000, maximum: 5_000, currency: "USD" }],
        },
      ],
    },
  })

  expect(advisory?.targetSeverity).toBeUndefined()
  expect(advisory?.checkpoint.reward?.target).toBeUndefined()
  expect(advisory?.checkpoint.reward?.upside).toBeUndefined()
  expect(advisory?.checkpoint.questions.join(" ")).not.toContain("next reward tier")
  expect(advisory?.checkpoint.questions.join(" ")).toMatch(/security invariant.*unwanted attacker effect/i)
})
