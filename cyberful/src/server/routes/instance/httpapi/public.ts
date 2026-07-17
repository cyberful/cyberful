// ── Public OpenAPI Normalization ─────────────────────────────────
// Rewrites the internal Effect-generated specification into the stable public
// schema, parameters, security, and response shapes consumed by client generation.
// → cyberful/src/server/client/index.ts — wraps the generated client surface.
// ─────────────────────────────────────────────────────────────────

import { OpenApi } from "effect/unstable/httpapi"
import { CyberfulHttpApi } from "./api"
import { QueryBooleanOpenApi } from "./groups/query"
import { isRecord } from "@/util/record"

type OpenApiParameter = {
  name: string
  in: string
  required?: boolean
  schema?: OpenApiSchema
}

type OpenApiOperation = {
  parameters?: OpenApiParameter[]
  responses?: Record<string, OpenApiResponse>
  requestBody?: {
    required?: boolean
    content?: Record<string, { schema?: OpenApiSchema }>
  }
  security?: unknown
}

type OpenApiPathItem = Partial<Record<"get" | "post" | "put" | "delete" | "patch", OpenApiOperation>>

type OpenApiSpec = {
  components?: {
    schemas?: Record<string, OpenApiSchema>
    securitySchemes?: Record<string, unknown>
  }
  paths?: Record<string, OpenApiPathItem>
}

type OpenApiSchema = {
  $ref?: string
  additionalProperties?: OpenApiSchema | boolean
  allOf?: OpenApiSchema[]
  anyOf?: OpenApiSchema[]
  description?: string
  enum?: Array<string | boolean>
  items?: OpenApiSchema
  maximum?: number
  minimum?: number
  oneOf?: OpenApiSchema[]
  pattern?: string
  prefixItems?: OpenApiSchema[]
  properties?: Record<string, OpenApiSchema>
  required?: string[]
  type?: string
}

type OpenApiResponse = {
  description?: string
  content?: Record<string, { schema?: OpenApiSchema }>
}

// ── Client Queries Preserve Their Public Value Types ────────────
// Effect schemas describe values after HTTP decoding, while generated clients
// model the values callers provide before URL encoding. Numeric and boolean
// parameters must therefore remain numbers and booleans in the public contract
// even though the server receives string query components. These route-specific
// overrides bridge that representation boundary without weakening runtime decode.
// ─────────────────────────────────────────────────────────────────
const QueryParameterSchemas: Record<string, OpenApiSchema> = {
  "GET /experimental/session start": { type: "number" },
  "GET /experimental/session roots": QueryBooleanOpenApi,
  "GET /experimental/session archived": QueryBooleanOpenApi,
  "GET /find/file limit": { type: "integer", minimum: 1, maximum: 200 },
  "GET /experimental/session cursor": { type: "number" },
  "GET /experimental/session limit": { type: "number" },
  "GET /session start": { type: "number" },
  "GET /session roots": QueryBooleanOpenApi,
  "GET /session limit": { type: "number" },
  "GET /session/{sessionID}/message limit": { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  "GET /vcs/diff context": { type: "integer", minimum: 0 },
  "GET /api/session limit": { type: "number" },
  "GET /api/session start": { type: "number" },
  "GET /api/session roots": QueryBooleanOpenApi,
  "GET /api/session/{sessionID}/message limit": { type: "number" },
}

const ClientComponentDescriptions: Record<string, string> = {
  LogLevel: "Log level",
}

function normalizeClientOpenApi(input: Record<string, unknown>) {
  // ── Normalization Owns Effect's Mutable Document ────────────────
  // OpenApi calls this transform only with the document it generated from
  // CyberfulHttpApi. That value is a mutable OpenAPI object, while the callback's
  // generic input type retains only a record boundary. The assertion restores the
  // concrete shape after provenance is established and before any field is read.
  // ─────────────────────────────────────────────────────────────────
  const spec = input as OpenApiSpec

  // ── Self-Referencing Components Are Recovered Before Rewriting ───
  // Effect's multi-document deduplicator can emit a component whose definition
  // refers only to itself when one schema AST appears both independently and in
  // an annotated union. Such a document cannot generate a useful client type.
  // Recovery happens before all other normalization so later rewrites operate on
  // concrete component definitions rather than a broken reference cycle.
  // ─────────────────────────────────────────────────────────────────
  fixSelfReferencingComponents(spec)

  // ── Optional Transport Nulls Are Not Client Values ──────────────
  // Effect emits an optional field as a union with null in its raw OpenAPI schema.
  // Generated callers omit those fields rather than sending null, so exposing the
  // transport union would widen every client input incorrectly. Normalization strips
  // only optional null branches and preserves fields whose public contract is truly
  // nullable.
  // ─────────────────────────────────────────────────────────────────
  const componentSchemas = spec.components?.schemas
  for (const [name, schema] of Object.entries(componentSchemas ?? {})) {
    if (componentSchemas) componentSchemas[name] = stripOptionalNull(structuredClone(schema))
  }
  normalizeComponentNames(spec)
  collapseDuplicateComponents(spec)
  applyClientSchemaOverrides(spec)
  normalizeComponentDescriptions(spec)
  addClientErrorSchemas(spec)
  delete spec.components?.securitySchemes

  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of ["get", "post", "put", "delete", "patch"] as const) {
      const operation = item[method]
      if (!operation) continue
      if (operation.requestBody) {
        delete operation.requestBody.required
        const body = operation.requestBody.content?.["application/json"]
        if (body?.schema) body.schema = stripOptionalNull(structuredClone(body.schema))
      }
      for (const response of Object.values(operation.responses ?? {})) {
        for (const content of Object.values(response.content ?? {})) {
          if (content.schema) content.schema = stripOptionalNull(structuredClone(content.schema))
        }
      }
      delete operation.security
      delete operation.responses?.["401"]
      normalizeClientErrorResponses(operation)
      normalizeClientOperation(operation, path, method)
      if ((path === "/event" || path === "/global/event") && method === "get") {
        // ── Raw SSE Routes Publish Their Actual Wire Schema ────────
        // Effect's raw streaming handlers cannot attach a first-class success schema
        // to the generated endpoint. The public document supplies the event union
        // explicitly so clients decode the same payloads the server emits. This
        // override applies only to the two authenticated SSE routes and leaves their
        // runtime streaming implementation unchanged.
        // ─────────────────────────────────────────────────────────────────
        operation.responses ??= {}
        operation.responses["200"] = {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema:
                path === "/event"
                  ? { $ref: "#/components/schemas/Event" }
                  : { $ref: "#/components/schemas/GlobalEvent" },
            },
          },
        }
      }
      const route = `${method.toUpperCase()} ${path}`
      for (const param of operation.parameters ?? []) normalizeParameter(param, route)
    }
  }
  deleteUnusedClientErrorComponents(spec)
  return input
}

function addClientErrorSchemas(spec: OpenApiSpec) {
  if (!spec.components?.schemas) return
  spec.components.schemas.BadRequestError = {
    type: "object",
    required: ["name", "data"],
    properties: {
      name: { type: "string", enum: ["BadRequest"] },
      data: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string" },
          kind: {
            type: "string",
            enum: ["Params", "Headers", "Query", "Body", "Payload"],
          },
        },
      },
    },
  }
  spec.components.schemas.NotFoundError = {
    type: "object",
    required: ["name", "data"],
    properties: {
      name: { type: "string", enum: ["NotFoundError"] },
      data: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string" },
        },
      },
    },
  }
}

function collapseDuplicateComponents(spec: OpenApiSpec) {
  const schemas = spec.components?.schemas
  if (!schemas) return
  for (const name of Object.keys(schemas)) {
    const base = name.replace(/\d+$/, "")
    if (base === name || !schemas[base]) continue
    if (stableSchema(schemas[name], schemas) !== stableSchema(schemas[base], schemas)) continue
    rewriteRefs(spec, name, base)
    delete schemas[name]
  }
}

function normalizeComponentNames(spec: OpenApiSpec) {
  const schemas = spec.components?.schemas
  if (!schemas) return
  for (const name of Object.keys(schemas)) {
    const next = componentTypeName(name)
    if (next === name) continue
    if (schemas[next]) {
      if (stableSchema(schemas[name], schemas) === stableSchema(schemas[next], schemas)) {
        rewriteRefs(spec, name, next)
        delete schemas[name]
      }
      continue
    }
    schemas[next] = schemas[name]
    rewriteRefs(spec, name, next)
    delete schemas[name]
  }
}

function componentTypeName(name: string) {
  if (!name.includes(".")) return name
  return name
    .split(".")
    .filter((part) => !/^\d+$/.test(part))
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join("")
}

function applyClientSchemaOverrides(spec: OpenApiSpec) {
  const schemas = spec.components?.schemas
  if (!schemas) return
  if (schemas.AgentConfig) schemas.AgentConfig.additionalProperties = {}
  if (schemas.Command?.properties?.template) schemas.Command.properties.template = { type: "string" }
  if (schemas.GlobalSession?.properties?.project)
    schemas.GlobalSession.properties.project = nullable(schemas.GlobalSession.properties.project)
  const providerOptions = schemas.ProviderConfig?.properties?.options
  if (providerOptions) providerOptions.additionalProperties = {}
  const model = schemas.ProviderConfig?.properties?.models?.additionalProperties
  const variants = typeof model === "object" ? model.properties?.variants?.additionalProperties : undefined
  if (variants && typeof variants === "object") variants.additionalProperties = {}
  const syncInfo = schemas.SyncEventSessionUpdated?.properties?.data?.properties?.info
  if (syncInfo?.properties) makePropertiesNullable(syncInfo.properties)
}

function normalizeComponentDescriptions(spec: OpenApiSpec) {
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    const description = ClientComponentDescriptions[name]
    if (description) {
      schema.description = description
      continue
    }
    delete schema.description
  }
}

function makePropertiesNullable(properties: Record<string, OpenApiSchema>) {
  for (const [key, value] of Object.entries(properties)) {
    if (key === "time" && value.properties) {
      makePropertiesNullable(value.properties)
      continue
    }
    properties[key] = nullable(value)
  }
}

function nullable(schema: OpenApiSchema): OpenApiSchema {
  if (flattenOptions(schema.anyOf ?? schema.oneOf)?.some((item) => item.type === "null")) return schema
  return { anyOf: [schema, { type: "null" }] }
}

function stableSchema(input: unknown, schemas: Record<string, OpenApiSchema>): string {
  return JSON.stringify(canonicalizeSchema(input, schemas))
}

function canonicalizeSchema(input: unknown, schemas: Record<string, OpenApiSchema>): unknown {
  if (Array.isArray(input)) return input.map((item) => canonicalizeSchema(item, schemas))
  if (!isRecord(input)) return input
  if (typeof input.$ref === "string") return { $ref: canonicalRef(input.$ref, schemas) }
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => key !== "description")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, canonicalizeSchema(value, schemas)]),
  )
}

function canonicalRef(ref: string, schemas: Record<string, OpenApiSchema>) {
  const name = ref.replace("#/components/schemas/", "")
  const base = name.replace(/\d+$/, "")
  if (base !== name && schemas[base]) return `#/components/schemas/${base}`
  return ref
}

function rewriteRefs(input: unknown, from: string, to: string): void {
  if (Array.isArray(input)) {
    for (const item of input) rewriteRefs(item, from, to)
    return
  }
  if (!isRecord(input)) return
  if (input.$ref === `#/components/schemas/${from}`) input.$ref = `#/components/schemas/${to}`
  for (const value of Object.values(input)) rewriteRefs(value, from, to)
}

function normalizeClientErrorResponses(operation: OpenApiOperation) {
  if (operation.responses?.["400"] && isClientBadRequestResponse(operation.responses["400"])) {
    operation.responses["400"] = clientErrorResponse("Bad request", "BadRequestError")
  }
  if (operation.responses?.["404"] && isBuiltInErrorResponse(operation.responses["404"], "NotFound")) {
    operation.responses["404"] = clientErrorResponse("Not found", "NotFoundError")
  }
}

function deleteUnusedClientErrorComponents(spec: OpenApiSpec) {
  for (const name of [
    "Unauthorized",
    "EffectHttpApiErrorBadRequest",
    "EffectHttpApiErrorNotFound",
    "effect_HttpApiError_BadRequest",
    "effect_HttpApiError_NotFound",
  ]) {
    if (referencesComponent(spec.paths, name)) continue
    delete spec.components?.schemas?.[name]
  }
}

function referencesComponent(input: unknown, name: string): boolean {
  if (Array.isArray(input)) return input.some((item) => referencesComponent(item, name))
  if (!isRecord(input)) return false
  if (input.$ref === `#/components/schemas/${name}`) return true
  return Object.values(input).some((value) => referencesComponent(value, name))
}

function normalizeClientOperation(operation: OpenApiOperation, path: string, method: string) {
  if (path === "/experimental/console/switch" && method === "post") delete operation.responses?.["400"]
  if ((path !== "/session/{sessionID}/message" && path !== "/session/{sessionID}/command") || method !== "post") return
  const response = operation.responses?.["200"]?.content?.["application/json"]
  if (!response) return
  response.schema = {
    type: "object",
    required: ["info", "parts"],
    properties: {
      info: { $ref: "#/components/schemas/AssistantMessage" },
      parts: {
        type: "array",
        items: { $ref: "#/components/schemas/Part" },
      },
    },
  }
}

function isRefResponse(response: OpenApiResponse, name: string) {
  return response.content?.["application/json"]?.schema?.$ref === `#/components/schemas/${name}`
}

function isBuiltInErrorResponse(response: OpenApiResponse, name: "BadRequest" | "NotFound") {
  return response.description === name || isRefResponse(response, `EffectHttpApiError${name}`)
}

function isClientBadRequestResponse(response: OpenApiResponse) {
  return isBuiltInErrorResponse(response, "BadRequest") || isRefResponse(response, "InvalidRequestError")
}

function clientErrorResponse(description: string, name: "BadRequestError" | "NotFoundError"): OpenApiResponse {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${name}` },
      },
    },
  }
}

function fixSelfReferencingComponents(spec: OpenApiSpec) {
  const schemas = spec.components?.schemas
  if (!schemas) return
  const selfRefs = new Set<string>()
  for (const [name, schema] of Object.entries(schemas)) {
    if (schema.$ref === `#/components/schemas/${name}`) selfRefs.add(name)
  }
  if (selfRefs.size === 0) return

  // ── Raw Regeneration Supplies The Concrete Definition ─────────
  // The normalization transform runs after Effect has generated its raw document.
  // Re-generating that document here yields the component definitions before this
  // transform mutates names, nullability, and client-specific shapes. Only entries
  // proven to be direct self-references are replaced, leaving unrelated generated
  // components and every later normalization step deterministic.
  // ─────────────────────────────────────────────────────────────────
  const raw: OpenApiSpec = OpenApi.fromApi(CyberfulHttpApi)
  const rawSchemas = raw.components?.schemas
  if (!rawSchemas) return
  for (const name of selfRefs) {
    if (rawSchemas[name]) schemas[name] = rawSchemas[name]
  }
}

/** Strip `{type:"null"}` arms that Effect's `Schema.optional` adds to OpenAPI unions. */
function stripOptionalNull(schema: OpenApiSchema): OpenApiSchema {
  if (schema.allOf?.length === 1) {
    const [constraint] = schema.allOf
    delete schema.allOf
    return stripOptionalNull({ ...schema, ...constraint })
  }
  if (isEmptyObjectUnion(schema)) return { type: "object", properties: {} }
  const options = flattenOptions(schema.anyOf ?? schema.oneOf)
  if (options) {
    const withoutNull = options.filter((item) => item.type !== "null")
    if (withoutNull.length === 1) return stripOptionalNull(withoutNull[0])
    if (schema.anyOf) schema.anyOf = withoutNull.map(stripOptionalNull)
    if (schema.oneOf) schema.oneOf = withoutNull.map(stripOptionalNull)
  }
  if (schema.allOf) {
    const allOf = schema.allOf.map(stripOptionalNull)
    if (schema.type) {
      delete schema.allOf
      for (const item of allOf) Object.assign(schema, item)
    } else {
      schema.allOf = allOf
    }
  }
  if (schema.prefixItems && schema.items) delete schema.prefixItems
  if (schema.items) schema.items = stripOptionalNull(schema.items)
  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties)) {
      schema.properties[key] = stripOptionalNull(value)
    }
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    schema.additionalProperties = stripOptionalNull(schema.additionalProperties)
  }
  return schema
}

function isEmptyObjectUnion(schema: OpenApiSchema) {
  const options = schema.anyOf ?? schema.oneOf
  return options?.length === 2 && options.some(isBareObjectSchema) && options.some(isBareArraySchema)
}

function isBareObjectSchema(schema: OpenApiSchema) {
  return schema.type === "object" && !schema.properties && !schema.additionalProperties
}

function isBareArraySchema(schema: OpenApiSchema) {
  return schema.type === "array" && !schema.items && !schema.prefixItems
}

function flattenOptions(options: OpenApiSchema[] | undefined): OpenApiSchema[] | undefined {
  return options?.flatMap((item) => flattenOptions(item.anyOf ?? item.oneOf) ?? [item])
}

function normalizeParameter(param: OpenApiParameter, route: string) {
  if (!param.schema || typeof param.schema !== "object") return
  if (param.in === "path") {
    param.schema = stripOptionalNull(param.schema)
    return
  }
  if (param.in === "query") {
    const override = QueryParameterSchemas[`${route} ${param.name}`]
    if (override) {
      param.schema = override
      return
    }
  }
  param.schema = stripOptionalNull(param.schema)
}

export const PublicApi = CyberfulHttpApi.annotateMerge(
  OpenApi.annotations({
    title: "cyberful",
    version: "1.0.0",
    description: "cyberful api",
    transform: normalizeClientOpenApi,
  }),
)
