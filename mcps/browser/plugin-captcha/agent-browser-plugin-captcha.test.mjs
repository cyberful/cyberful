// ── CAPTCHA Plugin Protocol Tests ────────────────────────────────
// Proves manifest discovery, provider mapping, bounded result polling, and the
// structured failure that permits Cyberful to fall back to a human operator.
// → mcps/browser/plugin-captcha/agent-browser-plugin-captcha.mjs — supplies the solver.
// ────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { CAPTCHA_PLUGIN_PROTOCOL, handlePluginRequest, solveCaptcha } from "./agent-browser-plugin-captcha.mjs"

const request = {
  protocol: CAPTCHA_PLUGIN_PROTOCOL,
  type: "captcha.solve",
  capability: "captcha.solve",
  request: {
    kind: "turnstile",
    url: "https://target.example/challenge",
    siteKey: "site-key",
    timeoutMs: 5_000,
    pollIntervalMs: 250,
  },
}

describe("agent-browser CAPTCHA plugin", () => {
  test("publishes the manifest expected by agent-browser", async () => {
    const result = await handlePluginRequest({
      protocol: CAPTCHA_PLUGIN_PROTOCOL,
      type: "plugin.manifest",
      capability: "plugin.manifest",
      request: {},
    })
    expect(result).toEqual({
      protocol: CAPTCHA_PLUGIN_PROTOCOL,
      success: true,
      response: {
        name: "captcha",
        version: "0.1.0",
        capabilities: ["command.run", "captcha.solve"],
      },
    })
  })

  test("creates and polls a bounded CapSolver task", async () => {
    const calls = []
    const responses = [
      { errorId: 0, taskId: "task-1" },
      { errorId: 0, status: "processing" },
      { errorId: 0, status: "ready", solution: { token: "solved-token" } },
    ]
    const result = await solveCaptcha(request.request, {
      env: { CAPSOLVER_API_KEY: "secret" },
      sleep: async () => {},
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) })
        return new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    })
    expect(result).toEqual({
      provider: "capsolver",
      kind: "turnstile",
      taskId: "task-1",
      solution: { token: "solved-token" },
    })
    expect(calls[0]).toEqual({
      url: "https://api.capsolver.com/createTask",
      body: {
        clientKey: "secret",
        task: {
          type: "AntiTurnstileTaskProxyLess",
          websiteURL: "https://target.example/challenge",
          websiteKey: "site-key",
        },
      },
    })
    expect(calls.slice(1).every((call) => call.url === "https://api.capsolver.com/getTaskResult")).toBe(true)
  })

  test("fails structurally when no solver credential is configured", async () => {
    const result = await handlePluginRequest(request, { env: {} })
    expect(result.protocol).toBe(CAPTCHA_PLUGIN_PROTOCOL)
    expect(result.success).toBe(false)
    expect(result.error).toContain("not configured")
  })

  test("maps generic Turnstile requests for 2Captcha", async () => {
    let submitted
    const result = await solveCaptcha(
      { ...request.request, provider: "2captcha" },
      {
        env: { TWOCAPTCHA_API_KEY: "secret" },
        fetch: async (_url, init) => {
          submitted = JSON.parse(init.body)
          return new Response(JSON.stringify({ errorId: 0, status: "ready", solution: { token: "token" } }))
        },
      },
    )
    expect(submitted.task.type).toBe("TurnstileTaskProxyless")
    expect(result.solution).toEqual({ token: "token" })
  })
})
