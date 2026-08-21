// ── First-Party MITRE ATT&CK MCP Server ─────────────────────────
// Publishes one bounded, structured, read-only tool over the release-embedded
// STIX 2.1 snapshot and records its immutable identity in the active workarea.
// → cyberful/src/subsystem/upstream.ts — launches this stdio server per phase.
// → cyberful/src/mitre-attack/store.ts — owns deterministic local queries.
// @docs/runtimes/mitre-attack.md
// ─────────────────────────────────────────────────────────────────

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { AttackStore } from "@/mitre-attack/store"
import { readAttackRuntimeSnapshot } from "@/mitre-attack/runtime"
import {
  ATTACK_DOMAINS,
  ATTACK_OBJECT_TYPES,
  type AttackDomain,
  type AttackObjectType,
  type AttackSnapshotManifest,
} from "@/mitre-attack/types"
import { replaceWorkareaFile } from "@/workarea"

export const MITRE_ATTACK_TOOL = "mitre_attack"
export const MITRE_ATTACK_SNAPSHOT_PATH = "raw/mitre-attack/snapshot.json"

const domainSchema = { type: "string" as const, enum: [...ATTACK_DOMAINS] }
const objectTypeSchema = { type: "string" as const, enum: [...ATTACK_OBJECT_TYPES] }
const domainsSchema = {
  type: "array" as const,
  maxItems: 3,
  uniqueItems: true,
  items: domainSchema,
  description: "Restrict results to Enterprise, Mobile, or ICS ATT&CK. Omit to search every embedded domain.",
}
const identifiersSchema = {
  type: "array" as const,
  minItems: 1,
  maxItems: 20,
  uniqueItems: true,
  items: { type: "string" as const, minLength: 1, maxLength: 300, pattern: "\\S" },
  description: "One to twenty exact ATT&CK IDs such as T1078.004 or STIX IDs such as attack-pattern--….",
}
const tacticsSchema = {
  type: "array" as const,
  maxItems: 20,
  uniqueItems: true,
  items: { type: "string" as const, minLength: 1, maxLength: 100, pattern: "\\S" },
}

function actionSchema(
  action: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: readonly string[] = [],
) {
  return {
    type: "object" as const,
    additionalProperties: false,
    description,
    properties: {
      action: { type: "string" as const, enum: [action], description },
      ...properties,
    },
    required: ["action", ...required],
  }
}

export const MITRE_ATTACK_TOOL_DEFINITION = {
  name: MITRE_ATTACK_TOOL,
  title: "MITRE ATT&CK",
  description:
    "Query the exact official STIX 2.1 ATT&CK snapshot embedded in this Cyberful release through one of five action-specific contracts. Call status first. Use returned ATT&CK facts instead of model memory; mappings remain hypotheses until evidence and Verify support them.",
  inputSchema: {
    type: "object" as const,
    oneOf: [
      actionSchema("status", "Report dataset readiness and the immutable release snapshot manifest."),
      actionSchema(
        "search",
        "Search object IDs, names, aliases, and descriptions. All query tokens and every supplied tactic or platform filter must match.",
        {
          query: {
            type: "string" as const,
            minLength: 1,
            maxLength: 256,
            pattern: "\\S",
            description: "One to 256 characters. Search tokens are normalized and combined with AND.",
            examples: ["Valid Accounts", "T1078.004"],
          },
          domains: domainsSchema,
          object_types: {
            type: "array" as const,
            maxItems: 4,
            uniqueItems: true,
            items: objectTypeSchema,
            description: "Restrict results to tactics, techniques, software, or groups.",
          },
          tactics: {
            ...tacticsSchema,
            description: "Exact tactic short names such as initial-access; every supplied value must match.",
          },
          platforms: {
            type: "array" as const,
            maxItems: 20,
            uniqueItems: true,
            items: { type: "string" as const, minLength: 1, maxLength: 100, pattern: "\\S" },
            description: "Exact ATT&CK platform names; every supplied value must match.",
          },
          include_revoked: { type: "boolean" as const, default: false, description: "Include revoked ATT&CK objects." },
          include_deprecated: {
            type: "boolean" as const,
            default: false,
            description: "Include deprecated ATT&CK objects.",
          },
          cursor: {
            type: "string" as const,
            minLength: 1,
            maxLength: 1_000,
            pattern: "\\S",
            description: "Opaque next_cursor from the same search request and filters.",
          },
          limit: {
            type: "integer" as const,
            minimum: 1,
            maximum: 100,
            default: 20,
            description: "Maximum objects in this page.",
          },
        },
        ["query"],
      ),
      actionSchema(
        "get",
        "Resolve exact ATT&CK or STIX identifiers. Exact lookup includes matching revoked or deprecated objects.",
        { identifiers: identifiersSchema, domains: domainsSchema },
        ["identifiers"],
      ),
      actionSchema(
        "relationships",
        "Traverse bounded relationships for exact objects. Domain, direction, type, and revoked-state filters apply to every returned relationship.",
        {
          identifiers: identifiersSchema,
          domains: domainsSchema,
          direction: {
            type: "string" as const,
            enum: ["incoming", "outgoing", "both"],
            default: "both",
            description:
              "Direction relative to each resolved identifier. Indirect group-to-technique paths are outgoing only.",
          },
          relationship_types: {
            type: "array" as const,
            maxItems: 20,
            uniqueItems: true,
            items: { type: "string" as const, minLength: 1, maxLength: 100, pattern: "\\S" },
            description: "Exact STIX relationship types, plus the synthetic uses-via-software type for indirect paths.",
          },
          include_indirect: {
            type: "boolean" as const,
            default: false,
            description:
              "Also derive outgoing group → software → technique paths. Use relationship_types=[uses-via-software] to request only those paths.",
          },
          include_revoked: {
            type: "boolean" as const,
            default: false,
            description: "Include revoked direct relationships.",
          },
          limit: {
            type: "integer" as const,
            minimum: 1,
            maximum: 500,
            default: 100,
            description: "Maximum relationships returned.",
          },
        },
        ["identifiers"],
      ),
      actionSchema(
        "matrix",
        "Return ordered tactics and bounded technique lists for one ATT&CK domain.",
        {
          domain: { ...domainSchema, description: "The one ATT&CK domain whose matrix is requested." },
          platform: {
            type: "string" as const,
            minLength: 1,
            maxLength: 100,
            pattern: "\\S",
            description: "Optional exact ATT&CK platform name such as Windows or Identity Provider.",
          },
          tactics: {
            ...tacticsSchema,
            description:
              "Optional tactic selectors: ATT&CK IDs, STIX IDs, or exact short names such as credential-access.",
          },
          include_revoked: { type: "boolean" as const, default: false, description: "Include revoked techniques." },
          include_deprecated: {
            type: "boolean" as const,
            default: false,
            description: "Include deprecated techniques.",
          },
          limit: {
            type: "integer" as const,
            minimum: 1,
            maximum: 50,
            default: 5,
            description:
              "Maximum technique records returned per selected tactic; total_techniques and truncated preserve full counts.",
          },
        },
        ["domain"],
      ),
    ],
  },
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("MITRE ATT&CK arguments must be an object")
  return value as Record<string, unknown>
}

function stringArray<T extends string>(
  value: unknown,
  label: string,
  options: {
    readonly allowed?: readonly T[]
    readonly maximumItems: number
    readonly maximumLength: number
    readonly required?: boolean
  },
): T[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > options.maximumItems || (options.required && value.length === 0)) {
    throw new Error(`${label} is invalid`)
  }
  const normalized = value.map((item) => (typeof item === "string" ? item.trim() : item))
  if (
    normalized.some(
      (item) =>
        typeof item !== "string" ||
        !item ||
        item.length > options.maximumLength ||
        (options.allowed && !options.allowed.includes(item as T)),
    ) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new Error(`${label} is invalid`)
  }
  return normalized as T[]
}

function boolean(value: unknown) {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new Error("MITRE ATT&CK boolean argument is invalid")
  return value
}

function integer(value: unknown, label: string, minimum: number, maximum: number) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be ${minimum} to ${maximum}`)
  }
  return Number(value)
}

function string(value: unknown, label: string, maximumLength: number, required = false) {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`${label} is invalid`)
  const normalized = value.trim()
  if ((!normalized && required) || normalized.length > maximumLength) throw new Error(`${label} is invalid`)
  return normalized
}

function exactArguments(args: Record<string, unknown>, action: string, names: readonly string[]) {
  const allowed = new Set(["action", ...names])
  const unexpected = Object.keys(args).find((name) => !allowed.has(name))
  if (unexpected) throw new Error(`MITRE ATT&CK ${action} does not accept '${unexpected}'`)
}

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  }
}

async function persistSnapshotReference(manifest: unknown) {
  const workarea = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim()
  if (!workarea) return
  await replaceWorkareaFile(workarea, MITRE_ATTACK_SNAPSHOT_PATH, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  })
}

export async function createMitreAttackServer(options?: {
  readonly databasePath?: string
  readonly manifest?: AttackSnapshotManifest
}) {
  const runtime =
    options?.databasePath && options.manifest
      ? { databasePath: options.databasePath, manifest: options.manifest }
      : readAttackRuntimeSnapshot()
  let store: AttackStore | undefined
  let unavailable: string | undefined
  if (runtime) {
    try {
      store = new AttackStore(runtime.databasePath, runtime.manifest)
      await persistSnapshotReference(runtime.manifest)
    } catch (error) {
      unavailable = error instanceof Error ? error.message : String(error)
    }
  } else {
    unavailable = "No build-produced MITRE ATT&CK snapshot is available; run make build."
  }
  const server = new Server({ name: "cyberful-mitre-attack", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [MITRE_ATTACK_TOOL_DEFINITION] }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== MITRE_ATTACK_TOOL) {
      return result({ error: "TOOL_NOT_FOUND", message: `Unknown tool '${request.params.name}'.` }, true)
    }
    try {
      const args = record(request.params.arguments)
      const action = string(args.action, "MITRE ATT&CK action", 40, true)
      if (action === "status") {
        exactArguments(args, action, [])
        return result(
          store
            ? { status: "ready", snapshot: store.manifest }
            : {
                status: "unavailable",
                error: "DATASET_UNAVAILABLE",
                message: unavailable ?? "MITRE ATT&CK dataset unavailable",
              },
        )
      }
      if (action === "search") {
        exactArguments(args, action, [
          "query",
          "domains",
          "object_types",
          "tactics",
          "platforms",
          "include_revoked",
          "include_deprecated",
          "limit",
          "cursor",
        ])
        const query = string(args.query, "MITRE ATT&CK search query", 256, true)
        if (!query) throw new Error("MITRE ATT&CK search requires query")
        const input = {
          query,
          domains: stringArray(args.domains, "MITRE ATT&CK domains", {
            allowed: ATTACK_DOMAINS,
            maximumItems: 3,
            maximumLength: 10,
          }) as AttackDomain[] | undefined,
          objectTypes: stringArray(args.object_types, "MITRE ATT&CK object types", {
            allowed: ATTACK_OBJECT_TYPES,
            maximumItems: 4,
            maximumLength: 20,
          }) as AttackObjectType[] | undefined,
          tactics: stringArray(args.tactics, "MITRE ATT&CK tactics", { maximumItems: 20, maximumLength: 100 }),
          platforms: stringArray(args.platforms, "MITRE ATT&CK platforms", { maximumItems: 20, maximumLength: 100 }),
          includeRevoked: boolean(args.include_revoked),
          includeDeprecated: boolean(args.include_deprecated),
          limit: integer(args.limit, "MITRE ATT&CK search limit", 1, 100),
          cursor: string(args.cursor, "MITRE ATT&CK search cursor", 1_000),
        }
        if (!store)
          return result(
            { error: "DATASET_UNAVAILABLE", message: unavailable ?? "MITRE ATT&CK dataset unavailable" },
            true,
          )
        return result({ snapshot: store.manifest, ...store.search(input) })
      }
      if (action === "get") {
        exactArguments(args, action, ["identifiers", "domains"])
        const identifiers = stringArray(args.identifiers, "MITRE ATT&CK identifiers", {
          maximumItems: 20,
          maximumLength: 300,
          required: true,
        })
        if (!identifiers) throw new Error("MITRE ATT&CK get requires identifiers")
        const domains = stringArray(args.domains, "MITRE ATT&CK domains", {
          allowed: ATTACK_DOMAINS,
          maximumItems: 3,
          maximumLength: 10,
        }) as AttackDomain[] | undefined
        if (!store)
          return result(
            { error: "DATASET_UNAVAILABLE", message: unavailable ?? "MITRE ATT&CK dataset unavailable" },
            true,
          )
        return result({ snapshot: store.manifest, items: store.get(identifiers, domains) })
      }
      if (action === "relationships") {
        exactArguments(args, action, [
          "identifiers",
          "domains",
          "direction",
          "relationship_types",
          "include_indirect",
          "include_revoked",
          "limit",
        ])
        const identifiers = stringArray(args.identifiers, "MITRE ATT&CK identifiers", {
          maximumItems: 20,
          maximumLength: 300,
          required: true,
        })
        if (!identifiers) throw new Error("MITRE ATT&CK relationships requires identifiers")
        const requestedDirection = string(args.direction, "MITRE ATT&CK relationship direction", 20)
        if (
          requestedDirection &&
          requestedDirection !== "incoming" &&
          requestedDirection !== "outgoing" &&
          requestedDirection !== "both"
        ) {
          throw new Error("MITRE ATT&CK relationship direction is invalid")
        }
        const direction = requestedDirection as "incoming" | "outgoing" | "both" | undefined
        const input = {
          identifiers,
          domains: stringArray(args.domains, "MITRE ATT&CK domains", {
            allowed: ATTACK_DOMAINS,
            maximumItems: 3,
            maximumLength: 10,
          }) as AttackDomain[] | undefined,
          direction,
          relationshipTypes: stringArray(args.relationship_types, "MITRE ATT&CK relationship types", {
            maximumItems: 20,
            maximumLength: 100,
          }),
          includeIndirect: boolean(args.include_indirect),
          includeRevoked: boolean(args.include_revoked),
          limit: integer(args.limit, "MITRE ATT&CK relationship limit", 1, 500),
        }
        if (!store)
          return result(
            { error: "DATASET_UNAVAILABLE", message: unavailable ?? "MITRE ATT&CK dataset unavailable" },
            true,
          )
        return result({ snapshot: store.manifest, ...store.relationships(input) })
      }
      if (action === "matrix") {
        exactArguments(args, action, [
          "domain",
          "platform",
          "tactics",
          "include_revoked",
          "include_deprecated",
          "limit",
        ])
        const domain = string(args.domain, "MITRE ATT&CK matrix domain", 10, true)
        if (!domain || !ATTACK_DOMAINS.includes(domain as AttackDomain))
          throw new Error("MITRE ATT&CK matrix requires domain")
        const input = {
          domain: domain as AttackDomain,
          platform: string(args.platform, "MITRE ATT&CK matrix platform", 100),
          tactics: stringArray(args.tactics, "MITRE ATT&CK matrix tactics", { maximumItems: 20, maximumLength: 100 }),
          includeRevoked: boolean(args.include_revoked),
          includeDeprecated: boolean(args.include_deprecated),
          limit: integer(args.limit, "MITRE ATT&CK matrix limit", 1, 50),
        }
        if (!store)
          return result(
            { error: "DATASET_UNAVAILABLE", message: unavailable ?? "MITRE ATT&CK dataset unavailable" },
            true,
          )
        return result({ snapshot: store.manifest, matrices: store.matrix(input) })
      }
      throw new Error("MITRE ATT&CK action must be status, search, get, relationships, or matrix")
    } catch (error) {
      return result({ error: "INVALID_REQUEST", message: error instanceof Error ? error.message : String(error) }, true)
    }
  })
  server.onclose = async () => store?.close()
  return server
}

export async function runMitreAttackMain() {
  const server = await createMitreAttackServer()
  await server.connect(new StdioServerTransport())
}

if (import.meta.main) await runMitreAttackMain()
