// ── Host-Owned ZAP API Policy ───────────────────────────────────────
// Allows catalogued view and action calls while blocking lifecycle, listener,
// authentication, file-transfer, and raw-request paths owned by safer wrappers.
// → mcps/zap/zap_bridge.mjs — applies this policy to generic API calls.
// ────────────────────────────────────────────────────────────────────

const API_TYPES = new Set(["view", "action", "other"])
const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"])
const MAX_SCOPED_ORIGINS = 20
const BLOCKED_OPERATIONS = [
  /^core:action:shutdown$/i,
  // Raw transport crosses the scope boundary only through zap_http_request, which validates and
  // canonicalizes the destination before delegating to this otherwise ambiguous ZAP action.
  /^core:action:sendrequest$/i,
  // History bodies cross the model/disk boundary only through the metadata-first wrappers, whose
  // include_bodies opt-in and content-addressed store cannot be bypassed through zap_api_call.
  /^core:view:messages?$/i,
  /^filexfer:/i,
  /^core:(?:action|other):file(?:upload|download)$/i,
  /^core:action:setoption.*api/i,
  /^core:action:setoptionproxy(?:ip|port)$/i,
  /^mcp:action:setoption(?:enabled|address|port|securitykey|securitykeyenabled)$/i,
  /^network:action:.*(?:localserver|alias)$/i,
]

export function operationKey(component, type, operation) {
  return `${component}:${type}:${operation}`
}

export function assertAllowedOperation(component, type, operation) {
  if (!API_TYPES.has(type)) throw new Error(`unsupported ZAP API type: ${type}`)
  const key = operationKey(component, type, operation)
  if (!isAllowedOperation(component, type, operation)) {
    throw new Error(`host-owned ZAP operation is blocked: ${key}`)
  }
  return key
}

export function isAllowedOperation(component, type, operation) {
  return (
    API_TYPES.has(type) && !BLOCKED_OPERATIONS.some((pattern) => pattern.test(operationKey(component, type, operation)))
  )
}

export function apiParameters(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (item === undefined || item === null) return []
      if (Array.isArray(item)) {
        if (item.some((entry) => typeof entry === "object" && entry !== null)) {
          throw new Error(`ZAP API parameter ${key} must be flat`)
        }
        return [[key, item.join(",")]]
      }
      if (typeof item === "object") throw new Error(`ZAP API parameter ${key} must be flat`)
      return [[key, typeof item === "string" ? item : String(item)]]
    }),
  )
}

// ── Scoped ZAP Calls Stay Inside Host Authorization ───────────────
// Pentest owns its engagement ZAP surface. When the host supplies an exact
// origin list, arbitrary actions, OAST callbacks, redirects, and unknown
// official tools fail closed. Direct HTTP requests are checked again after
// their raw request has been normalized.
// ────────────────────────────────────────────────────────────────────

export function parseZapAllowedOrigins(raw) {
  if (raw === undefined) return null
  let values
  try {
    values = JSON.parse(raw)
  } catch (error) {
    throw new Error("CYBER_ZAP_ALLOWED_ORIGINS must contain valid JSON", { cause: error })
  }
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_SCOPED_ORIGINS) {
    throw new Error(`CYBER_ZAP_ALLOWED_ORIGINS must contain 1-${MAX_SCOPED_ORIGINS} origins`)
  }
  const origins = values.map((value, index) => {
    if (typeof value !== "string" || value.length > 2048) {
      throw new Error(`CYBER_ZAP_ALLOWED_ORIGINS[${index}] must be an exact origin`)
    }
    let url
    try {
      url = new URL(value)
    } catch (error) {
      throw new Error(`CYBER_ZAP_ALLOWED_ORIGINS[${index}] is invalid`, { cause: error })
    }
    if (
      !NETWORK_PROTOCOLS.has(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== value
    ) {
      throw new Error(`CYBER_ZAP_ALLOWED_ORIGINS[${index}] must be a credential-free exact origin`)
    }
    return url.origin
  })
  if (new Set(origins).size !== origins.length) throw new Error("CYBER_ZAP_ALLOWED_ORIGINS contains duplicates")
  return Object.freeze(origins)
}

export function assertZapUrlAllowed(allowedOrigins, value, label = "ZAP URL") {
  if (allowedOrigins === null) return
  let url
  try {
    url = new URL(value)
  } catch (error) {
    throw new Error(`${label} must be an absolute network URL`, { cause: error })
  }
  if (!NETWORK_PROTOCOLS.has(url.protocol) || !allowedOrigins.includes(url.origin)) {
    throw new Error(`${label} origin is outside the host-authorized scope: ${url.origin}`)
  }
}

function validateEmbeddedUrls(allowedOrigins, value) {
  if (typeof value === "string") {
    if (!/^(?:https?|wss?):\/\//i.test(value)) return 0
    assertZapUrlAllowed(allowedOrigins, value)
    return 1
  }
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + validateEmbeddedUrls(allowedOrigins, item), 0)
  }
  if (value && typeof value === "object") {
    return Object.values(value).reduce((count, item) => count + validateEmbeddedUrls(allowedOrigins, item), 0)
  }
  return 0
}

const SCOPED_CONTEXT_ACTIONS = new Set([
  "newcontext",
  "removecontext",
  "includeincontext",
  "excludeincontext",
  "excludeFromContext".toLowerCase(),
  "setcontextinscope",
  "setauthenticationmethod",
  "setloggedinindicator",
  "setloggedoutindicator",
  "setsessionmanagementmethod",
  "newuser",
  "removeuser",
  "setuserenabled",
  "setauthenticationcredentials",
  "setforceduser",
  "setforcedusermodeenabled",
])

const NETWORK_OPERATION =
  /(?:scan|spider|attack|request|import|openapi|graphql|ajax|fuzz|oast|callback|boast|interact)/i
const READ_OPERATION = /(?:status|result|report|history|alert|version|list|get|view)/i

export function assertScopedZapTool(name, args, allowedOrigins, official = false) {
  if (allowedOrigins === null) return
  const explicitUrls = validateEmbeddedUrls(allowedOrigins, args)
  if (official) {
    if (NETWORK_OPERATION.test(name) && !READ_OPERATION.test(name) && explicitUrls === 0) {
      throw new Error(`official ZAP tool ${name} requires an explicit host-authorized target URL`)
    }
    return
  }
  if (name === "zap_oast") {
    const capabilityDiscovery = args?.operation === undefined && args?.type === undefined
    if (capabilityDiscovery || args?.type === "view") return
    if (explicitUrls === 0) throw new Error("ZAP OAST actions require an explicit host-authorized service URL")
  }
  if (name === "zap_api_call" && args?.type !== "view" && args?.type !== undefined) {
    const operation = typeof args.operation === "string" ? args.operation.toLowerCase() : ""
    const passiveConfiguration =
      SCOPED_CONTEXT_ACTIONS.has(operation) ||
      /^(?:setoption|enable|disable|clear|remove|exclude|include)/i.test(operation)
    if (!passiveConfiguration && explicitUrls === 0) {
      throw new Error("this ZAP action requires an explicit host-authorized target URL")
    }
  }
  if (name === "zap_http_request" && args?.follow_redirects === true) {
    throw new Error("ZAP redirects are disabled under exact-origin AppSec scope")
  }
  if (name === "zap_context_auth" && args?.type === "action") {
    const operation = typeof args.operation === "string" ? args.operation.toLowerCase() : ""
    if (!SCOPED_CONTEXT_ACTIONS.has(operation)) {
      throw new Error(`ZAP context action ${args.operation || "<missing>"} is unavailable under exact-origin scope`)
    }
  }
}
