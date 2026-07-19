// ── ZAP OAST Capability Contract ─────────────────────────────────────────────
// Derives the zap_oast tool from the API catalog of the installed add-on.
// The packaged ZAP OAST API exposes service discovery and configuration under
// one `oast` component; registration, payload generation, polling, and event
// retrieval are Java service capabilities and must not be advertised as HTTP API.
// → mcps/zap/zap_bridge.mjs — executes only operations resolved here.
// ────────────────────────────────────────────────────────────────

const OAST_COMPONENT = "oast"

function catalogValues(catalog) {
  if (catalog instanceof Map) return catalog.values()
  if (catalog && typeof catalog[Symbol.iterator] === "function") return catalog
  throw new Error("ZAP OAST requires an iterable API catalog")
}

function operations(catalog) {
  return Array.from(catalogValues(catalog))
    .filter((entry) => entry?.component === OAST_COMPONENT && ["view", "action"].includes(entry.type))
    .map(({ component, type, operation }) => ({ component, type, operation }))
    .sort((left, right) => `${left.type}:${left.operation}`.localeCompare(`${right.type}:${right.operation}`))
}

function emptyResult(value) {
  if (value === undefined || value === null || value === "") return true
  if (Array.isArray(value)) return value.length === 0
  return typeof value === "object" && Object.keys(value).length === 0
}

// ── Capability Discovery Is A First-Class No-Traffic Operation ───────
// Calling zap_oast without an operation returns this structure and makes the
// installed boundary explicit before an experiment is designed. In particular,
// it prevents callers from guessing legacy `interactsh`, `boast`, or `callback`
// subcomponents and from falling back to fragile scripts when the HTTP API lacks
// lifecycle operations. No callback service is contacted by this preflight.
// ────────────────────────────────────────────────────────────────
export function oastCapabilities(catalog) {
  const available = operations(catalog)
  return {
    status: available.length ? "available" : "unavailable",
    component: OAST_COMPONENT,
    operations: available,
    lifecycle: {
      registration: "not_exposed_by_http_api",
      payload_generation: "not_exposed_by_http_api",
      polling: "not_exposed_by_http_api",
      interaction_history: "not_exposed_by_http_api",
    },
    guidance:
      "Use only the listed configuration/discovery operations. For a justified callback test, use an engagement-owned one-shot harness with an explicit self-test and cleanup; do not improvise ZAP scripts.",
  }
}

export function oastToolDefinition(catalog) {
  const available = operations(catalog)
  const operationNames = [...new Set(available.map((entry) => entry.operation))]
  return {
    name: "zap_oast",
    description:
      "Inspect or call the installed ZAP OAST HTTP API. Omit operation for a no-traffic capability report. " +
      "Only catalogued operations under component=oast are accepted; registration, payload generation, " +
      "polling, and interaction retrieval are not exposed by this add-on's HTTP API.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        component: {
          type: "string",
          const: OAST_COMPONENT,
          default: OAST_COMPONENT,
          description: "The installed add-on publishes every HTTP operation under the oast component.",
        },
        type: { type: "string", enum: ["view", "action"] },
        operation: {
          type: "string",
          ...(operationNames.length ? { enum: operationNames } : {}),
          description: "Omit to return the capability report without contacting an OAST provider.",
        },
        parameters: { type: "object", additionalProperties: true },
      },
    },
  }
}

// ── Resolution Rejects Guessed Lifecycle Operations Before ZAP ──────────
// Operation and type are resolved as one catalog pair because an operation name
// alone is not an authorization decision. Unsupported requests return the exact
// available pairs and explain the installed boundary. Successful calls receive
// an explicit completed/data-or-empty envelope, so a valid empty result cannot
// be confused with a transport or API failure.
// ────────────────────────────────────────────────────────────────
export function resolveOastOperation(catalog, args) {
  const component = args.component ?? OAST_COMPONENT
  if (component !== OAST_COMPONENT) {
    throw new Error(
      `ZAP OAST component ${String(component)} is not exposed by the installed HTTP API; use component=oast and inspect zap_oast without an operation first`,
    )
  }
  if (args.operation === undefined && args.type === undefined) return undefined
  if (typeof args.operation !== "string" || typeof args.type !== "string") {
    throw new Error("ZAP OAST calls require both type and operation; omit both for capability discovery")
  }
  const available = operations(catalog)
  const selected = available.find((entry) => entry.type === args.type && entry.operation === args.operation)
  if (selected) return selected
  const choices = available.map((entry) => `${entry.type}:${entry.operation}`).join(", ") || "none"
  throw new Error(
    `ZAP OAST operation ${args.type}:${args.operation} is unavailable in the installed API catalog; available operations: ${choices}`,
  )
}

export function completedOastCall(operation, result) {
  return {
    status: "completed",
    result_state: emptyResult(result) ? "empty" : "data",
    operation,
    result,
  }
}
