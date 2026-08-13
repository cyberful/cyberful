// ── DuckDuckGo Browser Search ───────────────────────────────────
// Builds bounded HTML-search navigations and extracts labelled result records
// from the live browser DOM without using a private search API.
// → mcps/browser/browser_mcp.mjs — owns Chromium and exposes web_search.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────

const SAFE_SEARCH_PARAMETERS = {
  strict: "1",
  moderate: "-1",
  off: "-2",
}

export function duckDuckGoSearchUrl(query, safeSearch = "moderate") {
  if (typeof query !== "string" || query.length < 1 || query.length > 500) {
    throw new Error("DuckDuckGo query must contain between 1 and 500 characters")
  }
  const safeSearchParameter = SAFE_SEARCH_PARAMETERS[safeSearch]
  if (safeSearchParameter === undefined) throw new Error("DuckDuckGo safe search mode is invalid")
  const url = new URL("https://html.duckduckgo.com/html/")
  url.searchParams.set("q", query)
  url.searchParams.set("kp", safeSearchParameter)
  return url.toString()
}

// ── Result Extraction Fails Loudly On Markup Drift ──────────────
// DuckDuckGo's HTML surface is intentionally simpler than its JavaScript UI,
// but its class names remain an external contract. The extractor accepts both
// HTML-result shapes and an equivalent semantic heading fallback, then
// distinguishes a genuine empty result page from unrecognized markup. Returning
// an empty success on parser drift would give an agent false evidence that no
// public sources exist, so an unknown layout is an explicit failure.
// ─────────────────────────────────────────────────────────────────
export function extractDuckDuckGoResultsDocument(
  maxResults,
  documentValue = globalThis.document,
  locationHref = globalThis.location?.href ?? "https://html.duckduckgo.com/html/",
) {
  const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim()
  const destinationUrl = (rawHref) => {
    if (!rawHref) return null
    let parsed
    try {
      parsed = new URL(rawHref, locationHref)
    } catch {
      return null
    }
    const duckDuckGoHost = parsed.hostname === "duckduckgo.com" || parsed.hostname.endsWith(".duckduckgo.com")
    const wrappedDestination = duckDuckGoHost
      ? parsed.pathname === "/l/"
        ? parsed.searchParams.get("uddg")
        : parsed.pathname === "/y.js"
          ? parsed.searchParams.get("u3")
          : null
      : null
    if (wrappedDestination) {
      try {
        parsed = new URL(wrappedDestination)
      } catch {
        return null
      }
    }
    const destination = parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null
    return destination && destination.length <= 8_192 ? destination : null
  }
  const resultNodes = [
    ...documentValue.querySelectorAll(".result"),
    ...documentValue.querySelectorAll('article[data-testid="result"]'),
  ].filter((node, index, nodes) => nodes.indexOf(node) === index)
  const recognized = resultNodes.flatMap((node) => {
    const link = node.querySelector('a.result__a, h2 a, a[data-testid="result-title-a"]')
    const url = destinationUrl(link?.getAttribute("href"))
    const title = compact(link?.textContent)
    if (!url || !title) return []
    const className = compact(node.className).toLowerCase()
    const badge = compact(
      node.querySelector('.badge--ad, .result__badge, [data-testid="ad-badge"]')?.textContent,
    ).toLowerCase()
    const snippet = compact(
      node.querySelector('.result__snippet, [data-result="snippet"], [data-testid="result-snippet"]')
        ?.textContent,
    )
    const displayed = compact(
      node.querySelector('.result__url, .result__extras__url, [data-testid="result-extras-url-link"]')
        ?.textContent,
    )
    let fallbackDisplay = url
    try {
      const parsed = new URL(url)
      fallbackDisplay = `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`
    } catch {
      // The destination was already validated above; this is defensive only.
    }
    return [{
      kind: className.includes("result--ad") || className.includes("sponsored") || badge === "ad"
        ? "sponsored"
        : "organic",
      title,
      url,
      display_url: displayed || fallbackDisplay,
      snippet,
    }]
  })
  const pageText = compact(documentValue.body?.innerText)
  if (recognized.length === 0) {
    if (/verify (?:you are|that you are) human|human verification|automated requests|unusual traffic|captcha/i.test(pageText)) {
      throw new Error(
        'DuckDuckGo presented a visible human challenge; use browser_captcha_status and browser_captcha_handoff with profile "search"',
      )
    }
    if (/no results|no more results|did not match any documents/i.test(pageText)) {
      return { results: [], truncated: false }
    }
    throw new Error("DuckDuckGo result layout was not recognized")
  }
  return {
    results: recognized.slice(0, maxResults).map((result, index) => ({ rank: index + 1, ...result })),
    truncated: recognized.length > maxResults,
  }
}
