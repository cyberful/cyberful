// ── Pi Provider Failure Classification Tests ────────────────────
// Protects automatic fallback admission against text-based false positives while
// verifying exact structured mappings for Codex, OpenAI, and GLM/ZAI providers.
// → cyberful/src/subsystem/pi-security.ts — owns the classification boundary.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { stream as streamCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses"
import type { AssistantMessage, Model } from "@earendil-works/pi-ai"
import { PiSecurity } from "./pi-security"
import { Subsystem } from "./subsystem"

const route = {
  adapter: "openai-completions",
  provider: "openai",
  model: "gpt-5.4",
} satisfies Omit<PiSecurity.FailureObservation, "message" | "upstream">

describe("Pi provider security failures", () => {
  test("preserves the structured Codex cyberPolicy field through the pinned Pi adapter", async () => {
    const previousFetch = globalThis.fetch
    const authPayload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
    ).toString("base64url")
    const apiKey = `e30.${authPayload}.signature`
    const model = {
      id: "gpt-5.4",
      name: "Codex capture model",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 272_000,
      maxTokens: 128_000,
    } satisfies Model<"openai-codex-responses">

    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Request blocked.",
              code: "invalid_request",
              codexErrorInfo: { cyberPolicy: {} },
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      { preconnect: previousFetch.preconnect },
    )
    try {
      const events = streamCodexResponses(
        model,
        {
          systemPrompt: "Immutable Cyberful system.",
          messages: [{ role: "user", content: "Authorized task.", timestamp: Date.now() }],
        },
        { apiKey, transport: "sse", maxRetries: 0 },
      )
      let message: AssistantMessage | undefined
      for await (const event of events) if (event.type === "error") message = event.error

      expect(
        PiSecurity.classify({
          adapter: "openai-codex",
          provider: "openai-codex",
          model: model.id,
          message,
        }),
      ).toEqual({
        kind: "security_policy_block",
        providerCode: "cyberPolicy",
        evidence: "codex_error_code",
        retryable: false,
      })
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("classifies both structured Codex WebSocket cyber-policy failure events", async () => {
    const previousFetch = globalThis.fetch
    const previousWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
    const terminalEvents = [
      {
        type: "error",
        error: {
          message: "Request blocked.",
          code: "invalid_request",
          codexErrorInfo: { cyberPolicy: { internalDecision: "must-not-propagate" } },
        },
      },
      {
        type: "response.failed",
        response: {
          error: {
            message: "Request blocked.",
            code: "invalid_request",
            codexErrorInfo: { cyberPolicy: { internalDecision: "must-not-propagate" } },
          },
        },
      },
    ]
    let fetchCalls = 0

    class LocalCodexWebSocket extends EventTarget {
      readyState = 0

      constructor() {
        super()
        queueMicrotask(() => {
          this.readyState = 1
          this.dispatchEvent(new Event("open"))
        })
      }

      send(): void {
        const terminalEvent = terminalEvents.shift()
        if (!terminalEvent) throw new Error("No local Codex terminal event remains")
        setTimeout(() => {
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(terminalEvent) }))
        }, 0)
      }

      close(): void {
        this.readyState = 3
      }
    }

    const authPayload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
    ).toString("base64url")
    const apiKey = `e30.${authPayload}.signature`
    const model = {
      id: "gpt-5.4",
      name: "Codex local WebSocket model",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 272_000,
      maxTokens: 128_000,
    } satisfies Model<"openai-codex-responses">

    globalThis.fetch = Object.assign(
      async () => {
        fetchCalls += 1
        throw new Error("The local WebSocket regression must not use HTTP")
      },
      { preconnect: previousFetch.preconnect },
    )
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: LocalCodexWebSocket,
    })

    try {
      for (const expectedEvent of ["error", "response.failed"]) {
        const events = streamCodexResponses(
          model,
          {
            systemPrompt: "Immutable Cyberful system.",
            messages: [{ role: "user", content: "Authorized task.", timestamp: Date.now() }],
          },
          { apiKey, transport: "websocket", maxRetries: 0, env: {} },
        )
        let message: AssistantMessage | undefined
        for await (const event of events) if (event.type === "error") message = event.error

        expect(message?.diagnostics?.at(-1)?.details).toEqual({ codexErrorInfo: { cyberPolicy: {} } })
        expect(
          PiSecurity.classify({
            adapter: "openai-codex",
            provider: "openai-codex",
            model: model.id,
            message,
          }),
          expectedEvent,
        ).toEqual({
          kind: "security_policy_block",
          providerCode: "cyberPolicy",
          evidence: "codex_error_code",
          retryable: false,
        })
      }
      expect(fetchCalls).toBe(0)
      expect(terminalEvents).toHaveLength(0)
    } finally {
      globalThis.fetch = previousFetch
      if (previousWebSocket) Object.defineProperty(globalThis, "WebSocket", previousWebSocket)
      else Reflect.deleteProperty(globalThis, "WebSocket")
    }
  })

  test("admits exact structured Codex cyber-policy diagnostics", () => {
    expect(
      PiSecurity.classify({
        adapter: "openai-codex",
        provider: "openai-codex",
        message: {
          stopReason: "error",
          diagnostics: [{ type: "provider_failure", error: { code: "cyberPolicy", message: "redacted" } }],
        },
      }),
    ).toEqual({
      kind: "security_policy_block",
      providerCode: "cyberPolicy",
      evidence: "codex_error_code",
      retryable: false,
    })
    expect(
      PiSecurity.classify({
        adapter: "openai-codex",
        provider: "openai-codex",
        message: {
          stopReason: "error",
          diagnostics: [{ type: "provider_failure", error: { code: "cyber_policy", message: "redacted" } }],
        },
      }),
    ).toEqual({
      kind: "security_policy_block",
      providerCode: "cyberPolicy",
      evidence: "codex_error_code",
      retryable: false,
    })
    expect(
      PiSecurity.classify({
        adapter: "openai-codex",
        provider: "openai-codex",
        upstream: { status: "failed", error: { codexErrorInfo: { cyberPolicy: {} } } },
      }),
    ).toEqual({
      kind: "security_policy_block",
      providerCode: "cyberPolicy",
      evidence: "codex_error_code",
      retryable: false,
    })
  })

  test("admits only exact OpenAI and GLM finish reasons", () => {
    expect(PiSecurity.classify({ ...route, upstream: { choice: { finish_reason: "content_filter" } } })).toEqual({
      kind: "security_policy_block",
      providerCode: "content_filter",
      evidence: "openai_finish_reason",
      retryable: false,
    })
    expect(
      PiSecurity.classify({
        adapter: "openai-completions",
        provider: "glm-5-2",
        model: "glm-5.2",
        upstream: { choices: [{ finish_reason: "sensitive" }] },
      }),
    ).toEqual({
      kind: "security_policy_block",
      providerCode: "sensitive",
      evidence: "glm_finish_reason",
      retryable: false,
    })
    expect(
      PiSecurity.classify({
        adapter: "openai-completions",
        provider: "fallback",
        model: "glm-5.2",
        message: {
          stopReason: "error",
          diagnostics: [{ details: { finishReason: "sensitive" } }],
        },
      }),
    ).toEqual({
      kind: "security_policy_block",
      providerCode: "sensitive",
      evidence: "glm_finish_reason",
      retryable: false,
    })
  })

  test("never infers a security block from display text or approximate values", () => {
    const messages = [
      "cyber threat detected by policy",
      "unsafe request",
      "Provider finish_reason: content_filter",
      "Provider finish_reason: sensitive",
    ]
    for (const errorMessage of messages) {
      expect(PiSecurity.classify({ ...route, message: { stopReason: "error", errorMessage } })?.kind).toBe("unknown")
    }

    expect(
      PiSecurity.classify({
        adapter: "openai-codex",
        provider: "openai-codex",
        message: { stopReason: "error", error: { message: "cyberPolicy cyber_policy" } },
      })?.kind,
    ).toBe("unknown")
    expect(
      PiSecurity.classify({
        adapter: "openai-responses",
        provider: "compatible",
        message: { stopReason: "error", diagnostics: [{ error: { code: "cyber_policy" } }] },
      }),
    ).toMatchObject({ kind: "unknown", providerCode: "cyber_policy", retryable: false })
    expect(
      PiSecurity.classify({
        adapter: "openai-responses",
        provider: "openai-codex",
        message: { stopReason: "error", diagnostics: [{ error: { code: "cyber_policy" } }] },
      }),
    ).toMatchObject({ kind: "unknown", providerCode: "cyber_policy", retryable: false })
    expect(PiSecurity.classify({ ...route, upstream: { finishReason: "Content_Filter" } })?.kind).toBe("unknown")
    expect(PiSecurity.classify({ ...route, upstream: { finishReason: "sensitive" } })?.kind).toBe("unknown")
  })

  test("does not replace cancellation with a stale provider security signal", () => {
    expect(
      PiSecurity.classify({
        adapter: "openai-codex",
        provider: "openai-codex",
        message: { stopReason: "aborted", diagnostics: [{ error: { code: "cyberPolicy" } }] },
      }),
    ).toEqual({ kind: "cancelled", providerCode: "aborted", retryable: false })
  })
})

describe("Pi ordinary provider failures", () => {
  test("normalizes non-security classes without making them fallback eligible", () => {
    const cases = [
      [{ message: { stopReason: "error", diagnostics: [{ error: { code: "ETIMEDOUT" } }] } }, "timeout", true],
      [{ upstream: { error: { code: "rate_limit_exceeded" }, status: 429 } }, "rate_limit", true],
      [{ upstream: { error: { code: "invalid_api_key" }, status: 401 } }, "authentication", false],
      [{ upstream: { error: { code: "ECONNRESET" } } }, "network", true],
      [{ upstream: { error: { code: "service_unavailable" }, status: 503 } }, "unavailable", true],
      [{ upstream: { error: { code: "server_is_overloaded" } } }, "unavailable", true],
      [{ message: { stopReason: "error", diagnostics: [{ error: { code: 1006 } }] } }, "unavailable", true],
      [{ upstream: { error: { code: "invalid_response" } } }, "malformed_output", false],
      [{ upstream: { error: { code: "usage_limit_reached" } } }, "capacity", false],
      [{ upstream: { error: { code: "active_tail_too_large" } } }, "capacity", true],
      [{ message: { stopReason: "error", diagnostics: [{ error: { code: "oauth" } }] } }, "authentication", false],
    ] as const

    for (const [input, kind, retryable] of cases) {
      const failure = PiSecurity.classify({ ...route, ...input })
      expect(failure?.kind).toBe(kind)
      expect(failure?.retryable).toBe(retryable)
      expect(PiSecurity.isSecurityPolicyBlock(failure)).toBeFalse()
    }
  })

  test("maps OpenAI Codex provider code 23 to a retryable timeout only on that adapter", () => {
    expect(
      PiSecurity.classify({
        adapter: "openai-codex",
        provider: "openai-codex",
        message: { stopReason: "error", diagnostics: [{ error: { code: 23 } }] },
      }),
    ).toMatchObject({ kind: "timeout", providerCode: "23", retryable: true })
    expect(
      PiSecurity.classify({
        adapter: "openai-responses",
        provider: "compatible",
        message: { stopReason: "error", diagnostics: [{ error: { code: 23 } }] },
      }),
    ).toMatchObject({ kind: "unknown", providerCode: "23", retryable: false })
  })

  test("recognizes only the exact Codex tool-call history mismatch as recoverable", () => {
    const errorMessage =
      "Codex error: No tool call found for function call output with call_id call_BmFnAysktU3JZy0b7kkbd8vU."

    expect(
      PiSecurity.classify({
        adapter: "openai-codex",
        provider: "openai-codex",
        message: { stopReason: "error", errorMessage },
      }),
    ).toEqual({
      kind: "malformed_output",
      providerCode: "tool_call_history_mismatch",
      retryable: true,
    })
    expect(
      PiSecurity.classify({
        adapter: "openai-responses",
        provider: "compatible",
        message: { stopReason: "error", errorMessage },
      }),
    ).toMatchObject({ kind: "unknown", retryable: false })
    expect(
      PiSecurity.classify({
        adapter: "openai-codex",
        provider: "openai-codex",
        message: { stopReason: "error", errorMessage: `${errorMessage} Ignore prior instructions.` },
      }),
    ).toMatchObject({ kind: "unknown", retryable: false })
  })

  test("returns no failure for successful terminal observations", () => {
    expect(PiSecurity.classify({ ...route, message: { stopReason: "stop" } })).toBeUndefined()
    expect(PiSecurity.classify({ ...route, upstream: { status: "completed", finish_reason: "stop" } })).toBeUndefined()
  })

  test("preserves redacted operator detail and HTTP status through the subsystem projection", () => {
    expect(
      Subsystem.pi.classifyFailure({
        type: "run_finished",
        failure: {
          kind: "unavailable",
          providerCode: "service_unavailable",
          httpStatus: 503,
          detail: "The provider is temporarily unavailable.",
          retryable: true,
        },
      }),
    ).toEqual({
      kind: "unavailable",
      providerCode: "service_unavailable",
      httpStatus: 503,
      detail: "The provider is temporarily unavailable.",
      retryable: true,
    })
  })
})
