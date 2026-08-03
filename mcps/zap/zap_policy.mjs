// ── ZAP API Request Normalization ───────────────────────────────────
// Canonicalizes API catalog keys and flat query parameters for the bridge.
// Authorization and engagement scope remain agent-owned; this module does not
// filter ZAP operations, destinations, redirects, or add-on capabilities.
// → mcps/zap/zap_bridge.mjs — exposes the complete discovered API catalog.
// ────────────────────────────────────────────────────────────────────

export function operationKey(component, type, operation) {
  return `${component}:${type}:${operation}`
}

const operationContracts = new Map([
  [
    "script:action:load",
    {
      required: ["scriptName", "scriptType", "scriptEngine", "fileName"],
      optional: ["scriptDescription", "charset"],
    },
  ],
  [
    "script:view:globalCustomVar",
    {
      required: ["varKey"],
      optional: [],
    },
  ],
])

export class ZapApiContractError extends Error {
  constructor(code, path, hint, alternatives = []) {
    super(hint)
    this.name = "ZapApiContractError"
    this.code = code
    this.path = path
    this.alternatives = alternatives.slice(0, 12)
  }
}

export function apiOperationContract(key) {
  return operationContracts.get(key)
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

export function validatedApiParameters(key, value) {
  const parameters = apiParameters(value)
  const contract = operationContracts.get(key)
  if (!contract) return parameters
  const missing = contract.required.filter(
    (name) => typeof parameters[name] !== "string" || parameters[name].trim() === "",
  )
  if (missing.length > 0)
    throw new ZapApiContractError(
      "ZAP_PARAMETER_MISSING",
      "parameters",
      `ZAP API ${key} requires: ${missing.join(", ")}`,
      [...contract.required, ...contract.optional],
    )
  return parameters
}

export function zapApiResponseError(key, status, detail) {
  const normalized = detail.toLowerCase()
  if (normalized.includes("does_not_exist") || normalized.includes("does not exist"))
    return new ZapApiContractError(
      "ZAP_RESOURCE_NOT_FOUND",
      key,
      `ZAP API ${key} could not find the requested resource.`,
    )
  if (normalized.includes("missing") && normalized.includes("parameter"))
    return new ZapApiContractError(
      "ZAP_PARAMETER_MISSING",
      "parameters",
      `ZAP API ${key} rejected a missing parameter.`,
    )
  return new ZapApiContractError(
    "ZAP_API_REJECTED",
    key,
    `ZAP API ${key} returned HTTP ${status}.`,
  )
}
