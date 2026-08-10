// ── DuckDuckGo Search Contract Tests ────────────────────────────
// Verifies deterministic query URLs and bounded result extraction without
// requiring external network access or live search-engine markup in CI.
// → mcps/browser/duckduckgo_search.mjs — implements the tested contract.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { duckDuckGoSearchUrl, extractDuckDuckGoResultsDocument } from "./duckduckgo_search.mjs"

function element({ className = "", href, text = "", selectors = {} }) {
  return {
    className,
    textContent: text,
    getAttribute: (name) => name === "href" ? href ?? null : null,
    querySelector: (selector) => selectors[selector] ?? null,
  }
}

function result({ title, href, snippet, display, sponsored = false }) {
  const link = element({ href, text: title })
  return element({
    className: sponsored ? "result result--ad" : "result results_links",
    selectors: {
      'a.result__a, h2 a, a[data-testid="result-title-a"]': link,
      '.badge--ad, .result__badge, [data-testid="ad-badge"]': sponsored ? element({ text: "Ad" }) : null,
      '.result__snippet, [data-result="snippet"], [data-testid="result-snippet"]': element({ text: snippet }),
      '.result__url, .result__extras__url, [data-testid="result-extras-url-link"]': element({ text: display }),
    },
  })
}

function page(results, text = "Search results") {
  return {
    body: { innerText: text },
    querySelectorAll: (selector) => selector === ".result" ? results : [],
  }
}

describe("DuckDuckGo browser search", () => {
  test("encodes the query and explicit safe-search mode", () => {
    const moderate = new URL(duckDuckGoSearchUrl('CVE "browser escape" & PoC'))
    const strict = new URL(duckDuckGoSearchUrl("security research", "strict"))
    const off = new URL(duckDuckGoSearchUrl("security research", "off"))

    expect(moderate.origin + moderate.pathname).toBe("https://html.duckduckgo.com/html/")
    expect(moderate.searchParams.get("q")).toBe('CVE "browser escape" & PoC')
    expect(moderate.searchParams.get("kp")).toBe("-1")
    expect(strict.searchParams.get("kp")).toBe("1")
    expect(off.searchParams.get("kp")).toBe("-2")
  })

  test("unwraps result links, labels advertisements, and enforces the result limit", () => {
    const wrapped = `//duckduckgo.com/l/?uddg=${encodeURIComponent("https://example.test/advisory?id=7")}`
    const sponsoredWrapped = `https://duckduckgo.com/y.js?ad_domain=vendor.test&u3=${encodeURIComponent("https://vendor.test/scanner")}`
    const documentValue = page([
      result({
        title: "Security advisory",
        href: wrapped,
        snippet: "  Fixed in version 2.  ",
        display: "example.test/advisory",
      }),
      result({
        title: "Sponsored scanner",
        href: sponsoredWrapped,
        snippet: "Commercial result",
        display: "vendor.test/scanner",
        sponsored: true,
      }),
    ])
    const extracted = extractDuckDuckGoResultsDocument(
      2,
      documentValue,
      "https://html.duckduckgo.com/html/?q=test",
    )

    expect(extracted).toEqual({
      truncated: false,
      results: [
        {
          rank: 1,
          kind: "organic",
          title: "Security advisory",
          url: "https://example.test/advisory?id=7",
          display_url: "example.test/advisory",
          snippet: "Fixed in version 2.",
        },
        {
          rank: 2,
          kind: "sponsored",
          title: "Sponsored scanner",
          url: "https://vendor.test/scanner",
          display_url: "vendor.test/scanner",
          snippet: "Commercial result",
        },
      ],
    })
    expect(
      extractDuckDuckGoResultsDocument(1, documentValue, "https://html.duckduckgo.com/html/?q=test"),
    ).toMatchObject({ truncated: true, results: [{ rank: 1 }] })
  })

  test("distinguishes a genuine empty page from parser drift", () => {
    expect(extractDuckDuckGoResultsDocument(10, page([], "No results found."))).toEqual({
      results: [],
      truncated: false,
    })
    expect(() => extractDuckDuckGoResultsDocument(10, page([], "Unexpected landing page"))).toThrow(
      "result layout was not recognized",
    )
  })

  test("turns a static challenge page into an actionable profile-scoped error", () => {
    expect(() =>
      extractDuckDuckGoResultsDocument(10, page([], "Please verify you are human to continue")),
    ).toThrow('browser_captcha_status and browser_captcha_handoff with profile "search"')
  })
})
