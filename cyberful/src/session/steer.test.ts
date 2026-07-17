// ── Session Steering Tests ────────────────────────────────────────
// Verifies that live follow-up input inherits only the safe active-phase fields.
// → cyberful/src/session/prompt.ts — derives the tested steering metadata.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, SessionID } from "./schema"
import { MessageV2 } from "./message-v2"
import { carryEngagementStatus, steerHeadFields } from "./prompt"

const lastUser = (over: Partial<MessageV2.User> = {}): MessageV2.User => ({
  id: MessageID.make("msg_last_user"),
  sessionID: SessionID.make("ses_steer"),
  role: "user",
  time: { created: 1 },
  agent: "exploit",
  model: {
    providerID: ProviderID.make("codex-cli"),
    modelID: ModelID.make("codex"),
  },
  metadata: { workarea: "target-2026" },
  ...over,
})

describe("Codex live steering", () => {
  test("carries only phase, workarea and continuation metadata", () => {
    expect(steerHeadFields(lastUser())).toEqual({
      agent: "exploit",
      workarea: "target-2026",
      metadata: {
        workarea: "target-2026",
      },
    })
  })

  test("never carries a provider, model, variant, reasoning setting or system prompt", () => {
    const fields = steerHeadFields(lastUser({ system: "ignored by the journal marker" }))
    expect(fields).not.toHaveProperty("model")
    expect(fields).not.toHaveProperty("variant")
    expect(fields).not.toHaveProperty("think")
    expect(fields).not.toHaveProperty("system")
  })

  test("is total before a driving user turn exists", () => {
    expect(steerHeadFields(undefined)).toEqual({
      agent: undefined,
      workarea: undefined,
      metadata: undefined,
    })
  })
})

describe("busy human steer engagement status", () => {
  test("inherits a degraded chain status", () => {
    const previousMetadata = { expert_engagement_status: "completed_with_warnings" }
    expect(carryEngagementStatus({ metadata: undefined, delivery: "immediate", previousMetadata })).toEqual(
      previousMetadata,
    )
  })
})
