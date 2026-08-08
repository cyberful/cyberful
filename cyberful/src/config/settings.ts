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
import { link, open, rename, unlink } from "node:fs/promises"
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
const CompactionTriggerPercentage = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(50),
  Schema.isLessThanOrEqualTo(85),
)
const CompactionTargetPercentage = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(84),
)
const RetryCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10))
const RetryDelayMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(60_000))
const RetryAttemptTimeoutMs = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1_000),
  Schema.isLessThanOrEqualTo(600_000),
)
const PhaseExtensionMinutes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(60),
)
const ReasoningEffort = Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
export type ReasoningEffort = Schema.Schema.Type<typeof ReasoningEffort>

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "ultra"
export const DEFAULT_SUBAGENT_REASONING_EFFORT: ReasoningEffort = "xhigh"
export const DEFAULT_SUBAGENT_REASONING_EFFORTS: readonly ReasoningEffort[] = ["xhigh", "medium"]

export const DEFAULT_COMPACTION = {
  enabled: true,
  trigger_percentage: 75,
  target_percentage: 35,
  model_summary: true,
  summarizer: {
    provider: "inherit",
    reasoning_effort: "medium",
  },
} as const

export interface CompactionPolicy {
  readonly enabled: boolean
  readonly trigger_percentage: number
  readonly target_percentage: number
  readonly model_summary: boolean
  readonly summarizer: {
    readonly provider: string
    readonly reasoning_effort: ReasoningEffort
  }
}

export const DEFAULT_RETRY = {
  enabled: true,
  max_retries: 3,
  base_delay_ms: 1_000,
  max_delay_ms: 15_000,
  attempt_timeout_ms: 600_000,
  max_phase_extension_minutes: 15,
} as const

export interface RetryPolicy {
  readonly enabled: boolean
  readonly max_retries: number
  readonly base_delay_ms: number
  readonly max_delay_ms: number
  readonly attempt_timeout_ms: number
  readonly max_phase_extension_minutes: number
}

export interface SubagentPolicy {
  readonly provider: string
  readonly reasoning_efforts: readonly ReasoningEffort[]
  readonly default_reasoning_effort: ReasoningEffort
  readonly source: "configured" | "openai-codex-default" | "main-provider-fallback"
  readonly warning?: string
}

export const DEFAULT_PHASE_RECOVERY = {
  enabled: true,
  max_restarts: 1,
  use_fallback_provider: true,
} as const

export interface PhaseRecoveryPolicy {
  readonly enabled: boolean
  readonly max_restarts: number
  readonly use_fallback_provider: boolean
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
  operational_context_window: Schema.optional(PositiveInt),
  max_output_tokens: Schema.optional(PositiveInt),
}).annotate({ identifier: "PiProviderSettings" })
export type Provider = Schema.Schema.Type<typeof Provider>

export const Info = Schema.Struct({
  version: Schema.Literal(1),
  agent: Schema.Struct({
    subsystem: Schema.Literal("pi"),
    main_provider: ProviderName,
    reasoning_effort: Schema.optional(ReasoningEffort),
    fallback_provider: Schema.optional(ProviderName),
    subagents: Schema.Struct({
      enabled: Schema.Boolean,
      provider: Schema.optional(ProviderName),
      reasoning_effort: Schema.optional(Schema.Array(ReasoningEffort)),
      max_per_run: PositiveInt,
      max_concurrent: PositiveInt,
      max_depth: PositiveInt,
      timeout_minutes: Schema.optional(PositiveInt),
    }),
    compaction: Schema.optional(
      Schema.Struct({
        enabled: Schema.Boolean,
        trigger_percentage: CompactionTriggerPercentage,
        target_percentage: Schema.optional(CompactionTargetPercentage),
        model_summary: Schema.optional(Schema.Boolean),
        summarizer: Schema.optional(
          Schema.Struct({
            provider: Schema.Union([Schema.Literal("inherit"), ProviderName]),
            reasoning_effort: Schema.optional(ReasoningEffort),
          }),
        ),
      }),
    ),
    retry: Schema.optional(
      Schema.Struct({
        enabled: Schema.Boolean,
        max_retries: RetryCount,
        base_delay_ms: RetryDelayMs,
        max_delay_ms: RetryDelayMs,
        attempt_timeout_ms: Schema.optional(RetryAttemptTimeoutMs),
        max_phase_extension_minutes: Schema.optional(PhaseExtensionMinutes),
      }),
    ),
    phase_recovery: Schema.optional(
      Schema.Struct({
        enabled: Schema.Boolean,
        max_restarts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(3)),
        use_fallback_provider: Schema.Boolean,
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
  reasoning_effort: ultra

  subagents:
    enabled: true
    provider: openai-codex
    reasoning_effort: [xhigh, medium]
    max_per_run: 5
    max_concurrent: 5
    max_depth: 2
    timeout_minutes: 30

  compaction:
    enabled: true
    trigger_percentage: 75
    target_percentage: 35
    model_summary: true
    summarizer:
      provider: inherit
      reasoning_effort: medium

  retry:
    enabled: true
    max_retries: 3
    base_delay_ms: 1000
    max_delay_ms: 15000
    attempt_timeout_ms: 600000
    max_phase_extension_minutes: 15

  phase_recovery:
    enabled: true
    max_restarts: 1
    use_fallback_provider: true

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
      operational_context_window: 256000
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

// ── Legacy Scalar Child Reasoning Becomes An Allowlist ───────────
// Version 1 settings historically selected one fixed child effort. The runtime
// now accepts an allowlist while preserving `xhigh` as the non-negotiable
// default for an omitted parent choice. Parsing normalizes the old scalar before
// schema validation, so direct callers and files loaded before their atomic
// textual migration observe one canonical internal representation.
//
// @docs/user-guide/settings.md
// ─────────────────────────────────────────────────────────────────
function normalizeLegacySubagentReasoning(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.agent) || !isRecord(value.agent.subagents)) return value
  const effort = value.agent.subagents.reasoning_effort
  if (typeof effort !== "string") return value
  return {
    ...value,
    agent: {
      ...value.agent,
      subagents: {
        ...value.agent.subagents,
        reasoning_effort:
          effort === DEFAULT_SUBAGENT_REASONING_EFFORT
            ? [DEFAULT_SUBAGENT_REASONING_EFFORT]
            : [effort, DEFAULT_SUBAGENT_REASONING_EFFORT],
      },
    },
  }
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
  const compaction = settings.agent.compaction
  if (
    compaction?.target_percentage !== undefined &&
    compaction.target_percentage >= compaction.trigger_percentage
  ) {
    throw new InvalidError(filePath, [
      "agent.compaction.target_percentage must be lower than trigger_percentage",
    ])
  }
  const summarizerProvider = compaction?.summarizer?.provider
  if (summarizerProvider && summarizerProvider !== "inherit" && !settings.agent.providers[summarizerProvider]) {
    throw new InvalidError(filePath, [
      `agent.compaction.summarizer.provider references unconfigured provider "${summarizerProvider}"`,
    ])
  }
  const subagentProvider = settings.agent.subagents.provider
  if (subagentProvider && !settings.agent.providers[subagentProvider]) {
    throw new InvalidError(filePath, [
      `agent.subagents.provider references unconfigured provider "${subagentProvider}"`,
    ])
  }
  const subagentReasoning = settings.agent.subagents.reasoning_effort
  if (subagentReasoning) {
    if (!subagentReasoning.includes(DEFAULT_SUBAGENT_REASONING_EFFORT)) {
      throw new InvalidError(filePath, [
        `agent.subagents.reasoning_effort must include ${DEFAULT_SUBAGENT_REASONING_EFFORT}`,
      ])
    }
    if (new Set(subagentReasoning).size !== subagentReasoning.length) {
      throw new InvalidError(filePath, ["agent.subagents.reasoning_effort must not contain duplicates"])
    }
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
  return settings.agent.retry
    ? {
        ...settings.agent.retry,
        attempt_timeout_ms: settings.agent.retry.attempt_timeout_ms ?? DEFAULT_RETRY.attempt_timeout_ms,
        max_phase_extension_minutes:
          settings.agent.retry.max_phase_extension_minutes ??
          DEFAULT_RETRY.max_phase_extension_minutes,
      }
    : DEFAULT_RETRY
}

export function subagentPolicy(settings: Info): SubagentPolicy {
  const configured = settings.agent.subagents.provider
  const reasoningEfforts = settings.agent.subagents.reasoning_effort ?? DEFAULT_SUBAGENT_REASONING_EFFORTS
  if (configured) {
    return {
      provider: configured,
      reasoning_efforts: reasoningEfforts,
      default_reasoning_effort: DEFAULT_SUBAGENT_REASONING_EFFORT,
      source: "configured",
    }
  }
  if (settings.agent.providers["openai-codex"]) {
    return {
      provider: "openai-codex",
      reasoning_efforts: reasoningEfforts,
      default_reasoning_effort: DEFAULT_SUBAGENT_REASONING_EFFORT,
      source: "openai-codex-default",
    }
  }
  return {
    provider: settings.agent.main_provider,
    reasoning_efforts: reasoningEfforts,
    default_reasoning_effort: DEFAULT_SUBAGENT_REASONING_EFFORT,
    source: "main-provider-fallback",
    warning:
      "agent.subagents.provider is not configured and route openai-codex is unavailable; subagents inherit agent.main_provider",
  }
}

export function phaseRecoveryPolicy(settings: Info): PhaseRecoveryPolicy {
  return settings.agent.phase_recovery ?? DEFAULT_PHASE_RECOVERY
}

export function compactionPolicy(settings: Info): CompactionPolicy {
  const configured = settings.agent.compaction
  if (!configured) return DEFAULT_COMPACTION
  return {
    enabled: configured.enabled,
    trigger_percentage: configured.trigger_percentage,
    target_percentage: configured.target_percentage ?? DEFAULT_COMPACTION.target_percentage,
    model_summary: configured.model_summary ?? DEFAULT_COMPACTION.model_summary,
    summarizer: {
      provider: configured.summarizer?.provider ?? DEFAULT_COMPACTION.summarizer.provider,
      reasoning_effort:
        configured.summarizer?.reasoning_effort ??
        DEFAULT_COMPACTION.summarizer.reasoning_effort,
    },
  }
}

export function reasoningEffort(settings: Info): ReasoningEffort {
  return settings.agent.reasoning_effort ?? DEFAULT_REASONING_EFFORT
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
  return validateRouting(decode(normalizeLegacySubagentReasoning(value), source), source)
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

// ── Existing Settings Gain Explicit Reasoning Contracts ─────────
// Runtime defaults alone would make two visually identical settings files run
// with different assumptions across Cyberful versions. Loading an older file
// therefore inserts the root default and rewrites the former scalar child effort
// as an allowlist containing `xhigh`. Missing child policy receives the current
// explicit default. Atomic replacement occurs only while source text is unchanged,
// so concurrent operator edits are never overwritten by migration.
//
// @docs/user-guide/settings.md
// ─────────────────────────────────────────────────────────────────
function withDefaultReasoningEffort(text: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n"
  const trailingNewline = text.endsWith("\n")
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const agentStart = lines.findIndex((line) => /^agent:\s*(?:#.*)?$/.test(line))
  if (agentStart < 0) return text

  const agentEnd = lines.findIndex(
    (line, index) => index > agentStart && /^[^\s#][^:]*:\s*(?:.*)$/.test(line),
  )
  const boundary = agentEnd < 0 ? lines.length : agentEnd
  if (lines.slice(agentStart + 1, boundary).some((line) => /^  reasoning_effort:\s*/.test(line))) return text

  const subsystemIndex = lines.findIndex(
    (line, index) =>
      index > agentStart &&
      index < boundary &&
      /^  subsystem:\s*pi\s*(?:#.*)?$/.test(line),
  )
  if (subsystemIndex < 0) return text
  lines.splice(subsystemIndex + 1, 0, `  reasoning_effort: ${DEFAULT_REASONING_EFFORT}`)
  const migrated = lines.join(newline)
  return trailingNewline || migrated.endsWith(newline) ? migrated : `${migrated}${newline}`
}

function withSubagentReasoningAllowlist(text: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n"
  const trailingNewline = text.endsWith("\n")
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const subagentsStart = lines.findIndex((line) => /^  subagents:\s*(?:#.*)?$/.test(line))
  if (subagentsStart < 0) return text
  const subagentsEnd = lines.findIndex(
    (line, index) => index > subagentsStart && /^  [^\s#][^:]*:\s*(?:.*)$/.test(line),
  )
  const boundary = subagentsEnd < 0 ? lines.length : subagentsEnd
  const reasoningIndex = lines.findIndex(
    (line, index) => index > subagentsStart && index < boundary && /^    reasoning_effort:\s*/.test(line),
  )
  if (reasoningIndex >= 0) {
    const match = lines[reasoningIndex]?.match(
      /^    reasoning_effort:\s*([A-Za-z][A-Za-z0-9_-]*)\s*(#.*)?$/,
    )
    if (!match) return text
    const effort = match[1]
    const allowlist =
      effort === DEFAULT_SUBAGENT_REASONING_EFFORT
        ? `[${DEFAULT_SUBAGENT_REASONING_EFFORT}]`
        : `[${effort}, ${DEFAULT_SUBAGENT_REASONING_EFFORT}]`
    lines[reasoningIndex] = `    reasoning_effort: ${allowlist}${match[2] ? ` ${match[2]}` : ""}`
  } else {
    const providerIndex = lines.findIndex(
      (line, index) => index > subagentsStart && index < boundary && /^    provider:\s*/.test(line),
    )
    const enabledIndex = lines.findIndex(
      (line, index) => index > subagentsStart && index < boundary && /^    enabled:\s*/.test(line),
    )
    lines.splice(
      providerIndex >= 0 ? providerIndex + 1 : enabledIndex >= 0 ? enabledIndex + 1 : subagentsStart + 1,
      0,
      `    reasoning_effort: [${DEFAULT_SUBAGENT_REASONING_EFFORTS.join(", ")}]`,
    )
  }
  const migrated = lines.join(newline)
  return trailingNewline || migrated.endsWith(newline) ? migrated : `${migrated}${newline}`
}

function withSettingsMigrations(text: string): string {
  return withSubagentReasoningAllowlist(withDefaultReasoningEffort(text))
}

async function persistSettingsMigrations(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const original = await Bun.file(filePath).text()
    const migrated = withSettingsMigrations(original)
    if (migrated === original) return original

    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      const temporaryFile = await open(temporaryPath, "wx", 0o600)
      try {
        await temporaryFile.writeFile(migrated, "utf8")
        await temporaryFile.sync()
      } finally {
        await temporaryFile.close()
      }
      if ((await Bun.file(filePath).text()) !== original) continue
      await rename(temporaryPath, filePath)
      return migrated
    } finally {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }
  throw new Error(`Could not migrate reasoning settings in ${filePath}: the file changed during migration`)
}

export async function load(directory = process.cwd()): Promise<Info> {
  const filePath = path.join(directory, SETTINGS_FILENAME)
  await createDefaultIfMissing(filePath)
  return parse(await persistSettingsMigrations(filePath), filePath)
}
