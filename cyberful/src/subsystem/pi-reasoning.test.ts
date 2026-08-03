// ── Pi Reasoning Effort Resolution Tests ────────────────────────
// Verifies that the portable ultra profile resolves to provider-supported Pi
//   controls and never becomes an unsupported wire value.
// → cyberful/src/subsystem/pi-reasoning.ts — owns effort resolution.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import type { Api, Model } from "@earendil-works/pi-ai"
import { PiReasoning } from "./pi-reasoning"

function model(options: {
  readonly id: string
  readonly api?: Api
  readonly reasoning?: boolean
  readonly thinkingLevelMap?: Model<Api>["thinkingLevelMap"]
}): Model<Api> {
  return {
    id: options.id,
    name: options.id,
    api: options.api ?? "openai-codex-responses",
    provider: "configured",
    baseUrl: "https://provider.invalid",
    reasoning: options.reasoning ?? true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
    thinkingLevelMap: options.thinkingLevelMap,
  }
}

describe("Pi reasoning effort", () => {
  test("maps the ultra profile to GPT-5.6 Sol's supported max effort", () => {
    const plan = PiReasoning.resolve("ultra", model({ id: "gpt-5.6-sol", thinkingLevelMap: { max: "max" } }))
    expect(plan).toEqual({
      requested: "ultra",
      transport: "max",
      effective: "max",
    })
  })

  test("reports the clamped effective effort when a model lacks max", () => {
    const plan = PiReasoning.resolve(
      "ultra",
      model({
        id: "fallback-model",
        api: "openai-completions",
        thinkingLevelMap: { xhigh: "xhigh", max: null },
      }),
    )

    expect(plan).toEqual({
      requested: "ultra",
      transport: "xhigh",
      effective: "xhigh",
    })
  })

  test("turns reasoning off for a non-reasoning model", () => {
    expect(PiReasoning.resolve("ultra", model({ id: "plain", reasoning: false }))).toEqual({
      requested: "ultra",
      transport: "off",
      effective: "off",
    })
  })
})
