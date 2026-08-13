// ── Published Reward Policy Contract Tests ──────────────────────
// Protects official-source persistence, monetary range validation, and
//   explicit no-schedule states used by Bug Bounty maturation.
// → cyberful/src/subsystem/gateway/reward-policy.ts — owns the policy store.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { chmod, mkdtemp, readFile, realpath, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { expect, test } from "bun:test"
import { GatewayRewardPolicy } from "./reward-policy"

async function workarea() {
  const root = await mkdtemp(path.join(tmpdir(), "cyberful-reward-policy-"))
  await chmod(root, 0o700)
  return realpath(root)
}

test("stores the official monetary schedule with owner-only permissions", async () => {
  const root = await workarea()
  const store = new GatewayRewardPolicy.RewardPolicyStore(root)
  const policy = await store.set({
    action: "set",
    kind: "MONETARY",
    source: {
      url: "https://security.example.test/bug-bounty",
      observed_at: "2026-08-10T08:00:00.000Z",
      title: "Example Bug Bounty",
    },
    groups: [
      {
        id: "core-web",
        label: "Core web application",
        assets: ["app.example.test"],
        tiers: [
          { severity: "MEDIUM", minimum: 500, maximum: 1_000, currency: "usd" },
          { severity: "HIGH", minimum: 3_000, maximum: 5_000, currency: "usd" },
        ],
      },
    ],
  })

  expect(policy.kind).toBe("MONETARY")
  expect(policy.groups[0]?.id).toBe("core-web")
  expect(policy.groups[0]?.tiers[0]?.currency).toBe("USD")
  expect(await store.get()).toEqual(policy)
  const file = path.join(root, GatewayRewardPolicy.REWARD_POLICY_PATH)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(policy)
})

test("rejects inverted monetary ranges and groups on an unpublished schedule", async () => {
  const root = await workarea()
  const store = new GatewayRewardPolicy.RewardPolicyStore(root)
  await expect(
    store.set({
      action: "set",
      kind: "MONETARY",
      source: { url: "https://security.example.test/policy", observed_at: new Date().toISOString() },
      groups: [
        {
          id: "web",
          label: "Web",
          assets: ["app.example.test"],
          tiers: [{ severity: "HIGH", minimum: 5_000, maximum: 3_000, currency: "USD" }],
        },
      ],
    }),
  ).rejects.toThrow("maximum must be greater")

  await expect(
    store.set({
      action: "set",
      kind: "NOT_PUBLISHED",
      source: { url: "https://security.example.test/policy", observed_at: new Date().toISOString() },
      groups: [{ id: "web", label: "Web", assets: [], tiers: [] }],
    }),
  ).rejects.toThrow("cannot contain reward groups")
})

test("persists an explicit unavailable schedule without inventing tiers", async () => {
  const root = await workarea()
  const policy = await new GatewayRewardPolicy.RewardPolicyStore(root).set({
    action: "set",
    kind: "UNAVAILABLE",
    source: { url: "https://security.example.test/policy", observed_at: new Date().toISOString() },
    groups: [],
    note: "The official policy could not be retrieved during Brief.",
  })
  expect(policy).toMatchObject({ kind: "UNAVAILABLE", groups: [] })
})
