// ── Raw ZAP Request Routing Contract ────────────────────────────────
// Verifies absolute HTTPS requests retain their destination, origin-form input
// requires an explicit target, and recorded metadata reports the effective URL.
// → mcps/zap/zap_http_request.mjs — validates and normalizes raw requests.
// ────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { normalizedHttpRequest, recordedRequestTarget } from "./zap_http_request.mjs"

describe("ZAP raw HTTP request destination", () => {
  test("preserves an unambiguous absolute HTTPS request", () => {
    const raw = "GET https://example.com/path?q=1 HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n"
    expect(normalizedHttpRequest(raw)).toEqual({
      request: raw,
      targetUrl: "https://example.com/path?q=1",
      scheme: "https",
      normalizedOriginForm: false,
    })
  })

  test("uses target_url to convert origin-form without changing headers or body", () => {
    const raw = "POST /path?q=1 HTTP/1.1\nHost: example.com\nContent-Length: 4\n\nbody"
    expect(normalizedHttpRequest(raw, "https://example.com/path?q=1")).toEqual({
      request: "POST https://example.com/path?q=1 HTTP/1.1\nHost: example.com\nContent-Length: 4\n\nbody",
      targetUrl: "https://example.com/path?q=1",
      scheme: "https",
      normalizedOriginForm: true,
    })
  })

  test("rejects every ambiguous or inconsistent destination before ZAP", () => {
    const origin = "GET /path HTTP/1.1\r\nHost: example.com\r\n\r\n"
    expect(() => normalizedHttpRequest(origin)).toThrow("require target_url")
    expect(() => normalizedHttpRequest(origin, "https://example.com/other")).toThrow("path and query")
    expect(() => normalizedHttpRequest(origin, "https://other.example/path")).toThrow("Host header")
    expect(() =>
      normalizedHttpRequest(
        "GET https://example.com/path HTTP/1.1\r\nHost: example.com\r\n\r\n",
        "http://example.com/path",
      ),
    ).toThrow("exactly match")
    expect(() =>
      normalizedHttpRequest("OPTIONS * HTTP/1.1\r\nHost: example.com\r\n\r\n", "https://example.com/"),
    ).toThrow("absolute-form or origin-form")
    expect(() => normalizedHttpRequest("GET https://example.com/a HTTP/1.1\r\nHost: example.com")).toThrow("blank line")
  })

  test("requires one matching Host header and safe HTTP(S) URLs", () => {
    expect(() => normalizedHttpRequest("GET https://example.com/ HTTP/1.1\r\nConnection: close\r\n\r\n")).toThrow(
      "exactly one Host",
    )
    expect(() =>
      normalizedHttpRequest("GET https://example.com/ HTTP/1.1\r\nHost: example.com\r\nHost: example.com\r\n\r\n"),
    ).toThrow("exactly one Host")
    expect(() => normalizedHttpRequest("GET ftp://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n")).toThrow(
      "absolute-form or origin-form",
    )
    expect(() =>
      normalizedHttpRequest("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n", "https://user:pass@example.com/"),
    ).toThrow("credentials")
  })

  test("extracts the absolute target ZAP recorded", () => {
    expect(
      recordedRequestTarget({
        sendRequest: [{ requestHeader: "GET https://example.com/a HTTP/1.1\r\nHost: example.com" }],
      }),
    ).toBe("https://example.com/a")
    expect(() =>
      recordedRequestTarget({ sendRequest: [{ requestHeader: "GET /a HTTP/1.1\r\nHost: example.com" }] }),
    ).toThrow("ambiguous")
  })
})
