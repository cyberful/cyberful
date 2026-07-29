// ── Pi Runtime Settings Boundary ─────────────────────────────────
// Owns strict settings.yaml parsing, semantic provider routing validation, and
//   first-run creation of a secret-free OpenAI Codex subscription configuration.
// → cyberful/src/config/config.ts — owns the separate legacy JSONC application config.
// ─────────────────────────────────────────────────────────────────

export * as Settings from "./settings"

import { PositiveInt } from "@/schema"
import { isRecord } from "@/util/record"
import { Cause, Exit, Schema, SchemaIssue } from "effect"
import { randomUUID } from "node:crypto"
import { link, open, unlink } from "node:fs/promises"
import path from "node:path"
import matter from "gray-matter"

const SETTINGS_FILENAME = "settings.yaml"
const YAML_BOUNDARY = "--cyberful-settings-yaml-boundary--"
const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const INLINE_SECRET_KEYS = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "password",
  "secret",
  "token",
  "authorization",
])

const ProviderName = Schema.String.check(Schema.isPattern(PROVIDER_NAME_PATTERN))
const NonEmptyString = Schema.String.check(Schema.isPattern(/\S/))
const EnvironmentVariable = Schema.String.check(Schema.isPattern(ENVIRONMENT_VARIABLE_PATTERN))
const Percentage = Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100))
const CompactionPercentage = Schema.Int.check(Schema.isGreaterThanOrEqualTo(50), Schema.isLessThanOrEqualTo(85))
const RetryCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10))
const RetryDelayMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(60_000))

export const DEFAULT_COMPACTION = {
  enabled: true,
  trigger_percentage: 68,
} as const

export interface CompactionPolicy {
  readonly enabled: boolean
  readonly trigger_percentage: number
}

export const DEFAULT_RETRY = {
  enabled: true,
  max_retries: 3,
  base_delay_ms: 1_000,
  max_delay_ms: 15_000,
} as const

export interface RetryPolicy {
  readonly enabled: boolean
  readonly max_retries: number
  readonly base_delay_ms: number
  readonly max_delay_ms: number
}

const SubscriptionAuth = Schema.Struct({
  type: Schema.Literal("subscription"),
})

const EnvironmentAuth = Schema.Struct({
  type: Schema.Literal("environment"),
  variable: EnvironmentVariable,
})

export const Provider = Schema.Struct({
  adapter: NonEmptyString,
  model: NonEmptyString,
  auth: Schema.Union([SubscriptionAuth, EnvironmentAuth]),
  base_url: Schema.optional(NonEmptyString),
  context_window: Schema.optional(PositiveInt),
  max_output_tokens: Schema.optional(PositiveInt),
}).annotate({ identifier: "PiProviderSettings" })
export type Provider = Schema.Schema.Type<typeof Provider>

export const Info = Schema.Struct({
  version: Schema.Literal(1),
  agent: Schema.Struct({
    subsystem: Schema.Literal("pi"),
    main_provider: ProviderName,
    fallback_provider: Schema.optional(ProviderName),
    subagents: Schema.Struct({
      enabled: Schema.Boolean,
      max_per_run: PositiveInt,
      max_concurrent: PositiveInt,
      max_depth: PositiveInt,
    }),
    compaction: Schema.optional(
      Schema.Struct({
        enabled: Schema.Boolean,
        trigger_percentage: CompactionPercentage,
      }),
    ),
    retry: Schema.optional(
      Schema.Struct({
        enabled: Schema.Boolean,
        max_retries: RetryCount,
        base_delay_ms: RetryDelayMs,
        max_delay_ms: RetryDelayMs,
      }),
    ),
    fallback: Schema.Struct({
      proactive: Schema.Struct({
        enabled: Schema.Boolean,
        percentage: Percentage,
      }),
      automatic_security_block: Schema.Struct({
        enabled: Schema.Boolean,
      }),
    }),
    providers: Schema.Record(ProviderName, Provider),
  }),
  instructions: Schema.Struct({
    persona_roots: Schema.Array(NonEmptyString),
    skill_roots: Schema.Array(NonEmptyString),
    allow_project_discovery: Schema.Literal(false),
  }),
}).annotate({ identifier: "CyberfulSettings" })
export type Info = Schema.Schema.Type<typeof Info>

export const DEFAULT_YAML = `version: 1

agent:
  subsystem: pi
  main_provider: openai-codex

  subagents:
    enabled: true
    max_per_run: 4
    max_concurrent: 2
    max_depth: 2

  compaction:
    enabled: true
    trigger_percentage: 68

  retry:
    enabled: true
    max_retries: 3
    base_delay_ms: 1000
    max_delay_ms: 15000

  fallback:
    proactive:
      enabled: false
      percentage: 2
    automatic_security_block:
      enabled: false

  providers:
    openai-codex:
      adapter: openai-codex
      model: gpt-5.6-sol
      auth:
        type: subscription

instructions:
  persona_roots: []
  skill_roots: []
  allow_project_discovery: false
`

export class YamlError extends Error {
  readonly path: string

  constructor(filePath: string, reason?: string) {
    super(`Could not parse ${filePath} as YAML${reason ? `: ${reason}` : ""}`)
    this.name = "SettingsYamlError"
    this.path = filePath
  }
}

export class InvalidError extends Error {
  readonly path: string
  readonly issues: readonly string[]

  constructor(filePath: string, issues: readonly string[]) {
    super(`Invalid ${filePath}: ${issues.join("; ")}`)
    this.name = "SettingsInvalidError"
    this.path = filePath
    this.issues = issues
  }
}

// ── Settings Reject Secrets Before Diagnostic Formatting ────────
// The YAML document is untrusted and may contain a credential even when its key
// is outside the public schema. Detect well-known secret fields before Effect
// formats validation issues, because a third-party formatter may echo rejected
// values. Valid authentication selects provider-owned subscription login or an
// environment-variable reference, so inline credentials are never necessary.
// ─────────────────────────────────────────────────────────────────
function rejectInlineSecrets(value: unknown, filePath: string, segments: readonly string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectInlineSecrets(item, filePath, [...segments, String(index)]))
    return
  }
  if (!isRecord(value)) return

  for (const [key, item] of Object.entries(value)) {
    const itemPath = [...segments, key]
    const normalizedKey = key.toLowerCase().replaceAll("-", "").replaceAll("_", "")
    if (INLINE_SECRET_KEYS.has(normalizedKey)) {
      throw new InvalidError(filePath, [
        `${itemPath.join(".")} contains an inline secret; use subscription login or reference an environment variable`,
      ])
    }
    rejectInlineSecrets(item, filePath, itemPath)
  }
}

function yamlReason(error: unknown) {
  if (!isRecord(error) || typeof error.reason !== "string") return undefined
  return error.reason.replace(/\s+/g, " ").trim()
}

function decode(value: unknown, filePath: string): Info {
  rejectInlineSecrets(value, filePath)
  const decoded = Schema.decodeUnknownExit(Info)(value, {
    errors: "all",
    onExcessProperty: "error",
    propertyOrder: "original",
  })
  if (Exit.isSuccess(decoded)) return decoded.value

  const error = Cause.squash(decoded.cause)
  const issues = Schema.isSchemaError(error)
    ? SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => {
        const issuePath = issue.path?.map(String).join(".")
        return issuePath ? `${issuePath}: ${issue.message}` : issue.message
      })
    : ["settings do not match the required schema"]
  throw new InvalidError(filePath, issues)
}

// ── Routing References Are Validated Once At The File Boundary ───
// Provider names are user-authored map keys, while main and fallback routes
// are independent scalar references. Schema decoding proves each local shape;
// this pass proves the cross-field relationships and disables ambiguous routing.
// A single-provider file may run normally, but cannot enable proactive or
// automatic fallback without naming a distinct configured provider.
// ─────────────────────────────────────────────────────────────────
function validateRouting(settings: Info, filePath: string): Info {
  const providerNames = Object.keys(settings.agent.providers)
  if (providerNames.length === 0) {
    throw new InvalidError(filePath, ["agent.providers must contain at least one provider"])
  }
  if (!settings.agent.providers[settings.agent.main_provider]) {
    throw new InvalidError(filePath, [
      `agent.main_provider references unconfigured provider "${settings.agent.main_provider}"`,
    ])
  }

  const fallbackName = settings.agent.fallback_provider
  if (fallbackName === settings.agent.main_provider) {
    throw new InvalidError(filePath, ["agent.fallback_provider must be different from agent.main_provider"])
  }
  if (fallbackName && !settings.agent.providers[fallbackName]) {
    throw new InvalidError(filePath, [`agent.fallback_provider references unconfigured provider "${fallbackName}"`])
  }
  if (
    !fallbackName &&
    (settings.agent.fallback.proactive.enabled || settings.agent.fallback.automatic_security_block.enabled)
  ) {
    throw new InvalidError(filePath, [
      "agent.fallback_provider is required when proactive or automatic fallback is enabled",
    ])
  }
  if (
    settings.agent.retry !== undefined &&
    settings.agent.retry.max_delay_ms < settings.agent.retry.base_delay_ms
  ) {
    throw new InvalidError(filePath, ["agent.retry.max_delay_ms must be greater than or equal to base_delay_ms"])
  }

  for (const [providerName, provider] of Object.entries(settings.agent.providers)) {
    if (provider.base_url === undefined) continue
    let endpoint: URL
    try {
      endpoint = new URL(provider.base_url)
    } catch {
      throw new InvalidError(filePath, [`agent.providers.${providerName}.base_url must be an absolute URL`])
    }
    if (!["http:", "https:"].includes(endpoint.protocol)) {
      throw new InvalidError(filePath, [`agent.providers.${providerName}.base_url must use the http or https protocol`])
    }
    if (endpoint.username || endpoint.password) {
      throw new InvalidError(filePath, [`agent.providers.${providerName}.base_url must not contain inline credentials`])
    }
  }

  return settings
}

export function retryPolicy(settings: Info): RetryPolicy {
  return settings.agent.retry ?? DEFAULT_RETRY
}

export function compactionPolicy(settings: Info): CompactionPolicy {
  return settings.agent.compaction ?? DEFAULT_COMPACTION
}

export function parse(text: string, source = SETTINGS_FILENAME): Info {
  let value: unknown
  try {
    value = matter(`${YAML_BOUNDARY}\n${text}\n${YAML_BOUNDARY}\n`, {
      delimiters: YAML_BOUNDARY,
    }).data
  } catch (error) {
    throw new YamlError(source, yamlReason(error))
  }
  return validateRouting(decode(value, source), source)
}

// ── First-Run Creation Never Replaces Operator Configuration ────
// Concurrent launches may all observe an absent settings file. Each writes a
// complete owner-only temporary file and attempts one atomic hard-link into the
// launch directory; exactly one link can win and no rename can overwrite a file
// created by an operator or another process. Losers discard only their own
// temporary file, then every caller reads the same complete settings document.
// ─────────────────────────────────────────────────────────────────
async function createDefaultIfMissing(filePath: string) {
  if (await Bun.file(filePath).exists()) return

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    const temporaryFile = await open(temporaryPath, "wx", 0o600)
    try {
      await temporaryFile.writeFile(DEFAULT_YAML, "utf8")
      await temporaryFile.sync()
    } finally {
      await temporaryFile.close()
    }

    try {
      await link(temporaryPath, filePath)
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

export async function load(directory = process.cwd()): Promise<Info> {
  const filePath = path.join(directory, SETTINGS_FILENAME)
  await createDefaultIfMissing(filePath)
  return parse(await Bun.file(filePath).text(), filePath)
}
