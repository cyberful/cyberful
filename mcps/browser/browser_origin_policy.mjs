// ── Browser Origin Boundary ───────────────────────────────────
// Validates the private engagement origin allowlist and installs fail-closed
// HTTP and WebSocket interception on Playwright contexts.
// → mcps/browser/browser_mcp.mjs — applies this policy before page use.
// ──────────────────────────────────────────────────────────────────

const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"])
const INTERNAL_ABOUT_URLS = new Set(["about:blank", "about:srcdoc"])
const EXACT_ORIGIN_PATTERN = /^(?:https?|wss?):\/\/[^/?#\\]+\/?$/i
const ASCII_SPACE_OR_CONTROL_PATTERN = /[\u0000-\u0020\u007f]/
const MAX_ALLOWED_ORIGINS = 256
const MAX_ORIGIN_CHARS = 2048

export function parseBrowserAllowedOrigins(rawValue) {
  if (rawValue === undefined) return null
  if (typeof rawValue !== "string") {
    throw new Error("CYBER_BROWSER_ALLOWED_ORIGINS must be a JSON string array")
  }

  let decoded
  try {
    decoded = JSON.parse(rawValue)
  } catch (error) {
    throw new Error("CYBER_BROWSER_ALLOWED_ORIGINS must contain valid JSON", { cause: error })
  }

  if (!Array.isArray(decoded) || decoded.length === 0 || decoded.length > MAX_ALLOWED_ORIGINS) {
    throw new Error(`CYBER_BROWSER_ALLOWED_ORIGINS must contain 1-${MAX_ALLOWED_ORIGINS} origins`)
  }

  const origins = decoded.map((value, index) => {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_ORIGIN_CHARS) {
      throw new Error(`CYBER_BROWSER_ALLOWED_ORIGINS[${index}] must be a non-empty origin string`)
    }

    let parsed
    try {
      parsed = new URL(value)
    } catch (error) {
      throw new Error(`CYBER_BROWSER_ALLOWED_ORIGINS[${index}] is not a valid origin`, { cause: error })
    }

    if (
      !EXACT_ORIGIN_PATTERN.test(value) ||
      ASCII_SPACE_OR_CONTROL_PATTERN.test(value) ||
      value.includes("@") ||
      !NETWORK_PROTOCOLS.has(parsed.protocol) ||
      parsed.origin === "null" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error(
        `CYBER_BROWSER_ALLOWED_ORIGINS[${index}] must be an exact HTTP(S) or WS(S) origin without credentials, path, query, or fragment`,
      )
    }

    return parsed.origin
  })

  return Object.freeze([...new Set(origins)])
}

// ── Non-Network Documents Cannot Widen The Scope ─────────────────
// Chromium needs about:blank, about:srcdoc, and data documents for normal page
// construction, so rejecting every non-network URL would break the browser.
// Those documents remain useful without granting another network origin. Blob
// URLs are different: they inherit their creator's origin, which must itself be
// present in the exact allowlist. All other schemes fail closed.
//
// ──────────────────────────────────────────────────────────────────

export function browserUrlAllowed(allowedOrigins, rawUrl) {
  if (allowedOrigins === null) return true

  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch (error) {
    if (error instanceof TypeError) return false
    throw error
  }

  if (NETWORK_PROTOCOLS.has(parsed.protocol)) return allowedOrigins.includes(parsed.origin)
  if (parsed.protocol === "about:") return INTERNAL_ABOUT_URLS.has(parsed.href)
  if (parsed.protocol === "data:") return true
  if (parsed.protocol === "blob:") {
    return parsed.origin !== "null" && allowedOrigins.includes(parsed.origin)
  }
  return false
}

export function browserOriginContextOptions(allowedOrigins) {
  return allowedOrigins === null ? {} : { serviceWorkers: "block" }
}

// ── Every Browser Request Revalidates Its Destination ────────────────
// A navigation allow-check alone is insufficient because redirects, page
// scripts, subresources, and WebSockets can select a different destination.
// Context routes therefore decide each HTTP(S) and WS(S) connection at the
// final browser boundary. Callers install this before selecting a page, and an
// unavailable WebSocket interceptor fails closed instead of weakening scope.
//
// ────────────────────────────────────────────────────────────────

export async function installBrowserOriginPolicy(browserContext, allowedOrigins) {
  if (allowedOrigins === null) return
  if (typeof browserContext.route !== "function" || typeof browserContext.routeWebSocket !== "function") {
    throw new Error("The browser driver cannot enforce the configured HTTP and WebSocket origin policy")
  }

  await browserContext.route("**/*", async (route) => {
    if (browserUrlAllowed(allowedOrigins, route.request().url())) {
      await route.continue()
      return
    }
    await route.abort("blockedbyclient")
  })
  await browserContext.routeWebSocket("**/*", async (webSocketRoute) => {
    if (browserUrlAllowed(allowedOrigins, webSocketRoute.url())) {
      webSocketRoute.connectToServer()
      return
    }
    await webSocketRoute.close({ code: 1008, reason: "Origin outside the Cyberful engagement scope" })
  })
}
