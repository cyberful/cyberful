// ── Browser Origin Boundary Tests ─────────────────────────────────
// Protects exact-origin parsing and the fail-closed request decisions used by
// persistent and CDP-attached browser contexts.
// → mcps/browser/browser_origin_policy.mjs — owns the policy under test.
// ──────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import {
  browserOriginContextOptions,
  browserUrlAllowed,
  installBrowserOriginPolicy,
  parseBrowserAllowedOrigins,
} from "./browser_origin_policy.mjs"

describe("browser origin boundary", () => {
  test("leaves browser traffic unchanged when no private allowlist is present", async () => {
    const policy = parseBrowserAllowedOrigins(undefined)

    expect(policy).toBeNull()
    expect(browserUrlAllowed(policy, "https://outside.example/path")).toBe(true)
    expect(browserOriginContextOptions(policy)).toEqual({})
    await expect(installBrowserOriginPolicy({}, policy)).resolves.toBeUndefined()
  })

  test("canonicalizes exact HTTP and WebSocket origins", () => {
    const policy = parseBrowserAllowedOrigins(
      JSON.stringify(["HTTPS://Example.COM:443/", "wss://socket.example:8443", "https://example.com"]),
    )

    expect(policy).toEqual(["https://example.com", "wss://socket.example:8443"])
    expect(browserOriginContextOptions(policy)).toEqual({ serviceWorkers: "block" })
    expect(browserUrlAllowed(policy, "https://example.com/path?q=1")).toBe(true)
    expect(browserUrlAllowed(policy, "wss://socket.example:8443/events")).toBe(true)
    expect(browserUrlAllowed(policy, "https://sub.example.com/path")).toBe(false)
    expect(browserUrlAllowed(policy, "http://example.com/path")).toBe(false)
    expect(browserUrlAllowed(policy, "wss://socket.example/events")).toBe(false)
  })

  test("rejects malformed policy and values that are not exact network origins", () => {
    for (const rawValue of [
      "",
      "{}",
      "[]",
      JSON.stringify(["https://example.com/path"]),
      JSON.stringify(["https://example.com?"]),
      JSON.stringify(["https://example.com/%2e"]),
      JSON.stringify([" https://example.com"]),
      JSON.stringify(["https://@example.com"]),
      JSON.stringify(["https://user@example.com"]),
      JSON.stringify(["file:///tmp/repo"]),
      JSON.stringify(["https://example.com/?scope=wide"]),
    ]) {
      expect(() => parseBrowserAllowedOrigins(rawValue)).toThrow("CYBER_BROWSER_ALLOWED_ORIGINS")
    }
  })

  test("permits only required local documents and scope-owned blob URLs", () => {
    const policy = parseBrowserAllowedOrigins(JSON.stringify(["https://allowed.example"]))

    expect(browserUrlAllowed(policy, "about:blank")).toBe(true)
    expect(browserUrlAllowed(policy, "about:srcdoc")).toBe(true)
    expect(browserUrlAllowed(policy, "data:text/html,<p>fixture</p>")).toBe(true)
    expect(browserUrlAllowed(policy, "blob:https://allowed.example/88bde95e-3ee3-4dba-a33a-bfa2e0d11d30")).toBe(true)
    expect(browserUrlAllowed(policy, "blob:https://outside.example/88bde95e-3ee3-4dba-a33a-bfa2e0d11d30")).toBe(false)
    expect(browserUrlAllowed(policy, "blob:null/88bde95e-3ee3-4dba-a33a-bfa2e0d11d30")).toBe(false)
    expect(browserUrlAllowed(policy, "about:config")).toBe(false)
    expect(browserUrlAllowed(policy, "file:///tmp/repo/private.txt")).toBe(false)
    expect(browserUrlAllowed(policy, "chrome://settings/")).toBe(false)
    expect(browserUrlAllowed(policy, "not a URL")).toBe(false)
  })

  test("routes redirect targets and WebSockets through the same policy", async () => {
    const handlers = {}
    const browserContext = {
      async route(pattern, handler) {
        expect(pattern).toBe("**/*")
        handlers.http = handler
      },
      async routeWebSocket(pattern, handler) {
        expect(pattern).toBe("**/*")
        handlers.webSocket = handler
      },
    }
    const policy = parseBrowserAllowedOrigins(JSON.stringify(["https://allowed.example", "wss://allowed.example"]))
    await installBrowserOriginPolicy(browserContext, policy)

    const httpActions = []
    const httpRoute = (url) => ({
      request: () => ({ url: () => url }),
      continue: async () => httpActions.push("continue"),
      abort: async (reason) => httpActions.push(`abort:${reason}`),
    })
    await handlers.http(httpRoute("https://allowed.example/start"))
    await handlers.http(httpRoute("https://redirected-outside.example/landing"))
    expect(httpActions).toEqual(["continue", "abort:blockedbyclient"])

    const webSocketActions = []
    const webSocketRoute = (url) => ({
      url: () => url,
      connectToServer: () => webSocketActions.push("connect"),
      close: async ({ code, reason }) => webSocketActions.push(`close:${code}:${reason}`),
    })
    await handlers.webSocket(webSocketRoute("wss://allowed.example/events"))
    await handlers.webSocket(webSocketRoute("wss://outside.example/events"))
    expect(webSocketActions).toEqual(["connect", "close:1008:Origin outside the Cyberful engagement scope"])
  })

  test("fails closed when the browser cannot intercept WebSockets", async () => {
    const policy = parseBrowserAllowedOrigins(JSON.stringify(["https://allowed.example"]))

    await expect(
      installBrowserOriginPolicy(
        {
          route: async () => {},
        },
        policy,
      ),
    ).rejects.toThrow("cannot enforce")
  })
})
