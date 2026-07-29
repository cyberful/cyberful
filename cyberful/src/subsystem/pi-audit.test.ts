// ── Pi Audit Redaction Tests ─────────────────────────────────────
// Proves durable AgentRun audit records retain useful structure without
// persisting provider credentials or secret variable values.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { PiAudit } from "./pi-audit"

describe("Pi audit redaction", () => {
  test("redacts credential keys recursively while preserving ordinary token counters", () => {
    expect(
      PiAudit.redactValue({
        auth: {
          access: "raw-access-value",
          access_token: "access-value",
          refresh: "raw-refresh-value",
          refreshToken: "refresh-value",
        },
        max_output_tokens: 8192,
        nested: [{ apiKey: "key-value" }, { evidence: "safe" }],
      }),
    ).toEqual({
      auth: {
        access: "[REDACTED]",
        access_token: "[REDACTED]",
        refresh: "[REDACTED]",
        refreshToken: "[REDACTED]",
      },
      max_output_tokens: 8192,
      nested: [{ apiKey: "[REDACTED]" }, { evidence: "safe" }],
    })
  })

  test("redacts Pi api-key credential fields at the top-level audit boundary", () => {
    expect(
      PiAudit.redactValue({
        type: "api_key",
        key: "raw-provider-api-key",
        env: {
          ZAI_API_KEY: "raw-environment-api-key",
          PROVIDER_ACCOUNT: "private-provider-account",
        },
      }),
    ).toEqual({
      type: "api_key",
      key: "[REDACTED]",
      env: "[REDACTED]",
    })
  })

  test("redacts secret containers and credential-shaped text", () => {
    const redacted = PiAudit.redactValue({
      secret: true,
      value: "arbitrary-provider-value",
      note: "Authorization: Bearer abc.def.ghi and sk-example123456",
      endpoint: "https://user:password@example.test/v1",
    })
    expect(redacted).toEqual({
      secret: "[REDACTED]",
      value: "[REDACTED]",
      note: "Authorization: [REDACTED] [REDACTED] and [REDACTED]",
      endpoint: "https://[REDACTED]@example.test/v1",
    })
  })

  test("redacts raw OAuth field labels in serialized provider diagnostics", () => {
    expect(PiAudit.redactText("access=oauth-a refresh:oauth-r")).toBe(
      "access=[REDACTED] refresh:[REDACTED]",
    )
  })
})
