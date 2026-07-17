// ── Session Variable Store ───────────────────────────────────────────────────
// Persists reusable session-scoped values, resolves their template references,
// and redacts stored secrets from model-visible text.
// → cyberful/src/session/session.sql.ts — declares the variable table.
// ─────────────────────────────────────────────────────────────────────────────

import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { randomBytes } from "node:crypto"
import { MessageID, SessionID } from "./schema"
import { Effect, Layer, Context, Schema } from "effect"
import { Database } from "@/storage/db"
import { and, asc, eq } from "drizzle-orm"
import { SessionVariableTable } from "./session.sql"

const MIN_REDACT_LENGTH = 8
const MAX_DESCRIPTION_LENGTH = 120
const MAX_TEMPLATE_RESOLUTION_DEPTH = 16
const TEMPLATE_PATTERN = /\{\{\s*var:([A-Za-z_][A-Za-z0-9_.-]{0,127})\s*\}\}/g
const EXACT_TEMPLATE_PATTERN = /^\s*\{\{\s*var:([A-Za-z_][A-Za-z0-9_.-]{0,127})\s*\}\}\s*$/
const HOST_OWNED_PREFIX = "_cyberful_host_"

export function isHostOwnedName(name: string) {
  return name.startsWith(HOST_OWNED_PREFIX)
}

export const Name = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/)).annotate({
  identifier: "SessionVariableName",
  description: "Variable name, using letters, numbers, underscore, dash, and dot",
})
export type Name = Schema.Schema.Type<typeof Name>

export const Value = Schema.Json.annotate({ identifier: "SessionVariableValue" })
export type Value = Schema.Schema.Type<typeof Value>
export const decodeValue = Schema.decodeUnknownSync(Value)

export const SummaryInfo = Schema.Struct({
  name: Name,
  description: Schema.optional(Schema.String),
  type: Schema.String,
  size: Schema.Number,
  preview: Schema.String,
}).annotate({ identifier: "SessionVariableSummary" })
export type Summary = Schema.Schema.Type<typeof SummaryInfo>

export const Info = Schema.Struct({
  ...SummaryInfo.fields,
  value: Value,
}).annotate({ identifier: "SessionVariable" })
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Updated: BusEvent.define(
    "session.variable.updated",
    Schema.Struct({
      sessionID: SessionID,
      variables: Schema.Array(SummaryInfo),
    }),
  ),
}

export interface Interface {
  readonly set: (input: {
    sessionID: SessionID
    name: Name
    value: Value
    description?: string
    sourceMessageID?: MessageID
  }) => Effect.Effect<Summary>
  readonly get: (input: { sessionID: SessionID; name: Name }) => Effect.Effect<Info | undefined>
  readonly list: (sessionID: SessionID) => Effect.Effect<Summary[]>
  // ── Raw Variable Entries Stay At The Report Boundary ───────────
  // Ordinary variable reads expose redacted summaries to model-facing callers.
  // Final report rendering must resolve approved placeholders to their real values,
  // so it receives a separate host-only operation returning name/value pairs.
  // No tool, event, prompt, or list operation can reach this deliberate bypass.
  // ─────────────────────────────────────────────────────────────────
  readonly entries: (sessionID: SessionID) => Effect.Effect<ReadonlyArray<{ name: Name; value: Value }>>
  readonly delete: (input: { sessionID: SessionID; name: Name }) => Effect.Effect<boolean>
  readonly resolveTemplates: (sessionID: SessionID, input: unknown) => Effect.Effect<unknown>
  // ── Tool Actions Resolve More Strictly Than Narrative Text ─────
  // Commands, paths, requests, and targets must never receive unresolved variables.
  // Narrative document fields may mention placeholder syntax as prose, so their
  // unknown names remain literal and are reported to the caller. The general
  // resolver stays strict for every field outside this model-tool boundary.
  // ─────────────────────────────────────────────────────────────────
  readonly resolveToolTemplates: (
    sessionID: SessionID,
    toolID: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<{ args: Record<string, unknown>; unresolved: string[] }>
  readonly redact: (sessionID: SessionID, text: string) => Effect.Effect<string>
  readonly system: (sessionID: SessionID) => Effect.Effect<string>
  // Reserved secrets share the durable session table so workflow resume keeps attestations valid, but
  // are excluded from every model-facing list, template resolver, report entry, and variable operation.
  readonly hostSecret: (input: { sessionID: SessionID; name: Name }) => Effect.Effect<string>
  // Host lifecycle code may inspect an already-established reserved policy without making that value
  // visible through get/list/entries, templates, reports, events, or the model-facing variable tool.
  readonly hostValue: (input: { sessionID: SessionID; name: Name }) => Effect.Effect<Value | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@cyberful/SessionVariable") {}

export type Row = typeof SessionVariableTable.$inferSelect

function valueType(value: Value) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function valueText(value: Value) {
  return typeof value === "string" ? value : JSON.stringify(value)
}

function preview(value: Value) {
  return `<redacted:${valueType(value)}:${valueText(value).length} chars>`
}

// ── Serialized Non-Values Never Become Session Variables ────────
// Failed DOM reads and missing response fields often arrive as empty values or
// JavaScript coercion sentinels such as `undefined` and `[object Object]`.
// Accepting them would defer failure until a later command submits that literal.
// Both write boundaries and template resolution share this predicate so invalid
// extraction fails where it enters, including untyped gateway values.
// ─────────────────────────────────────────────────────────────────
const COERCION_SENTINELS = new Set(["undefined", "null", "nan", "[object object]"])
export function unusableValueReason(value: unknown): string | undefined {
  if (value === null || value === undefined) return "the value is null/undefined — the source produced nothing"
  const text = (typeof value === "string" ? value : (JSON.stringify(value) ?? "")).trim()
  if (text === "") return "the value is empty"
  if (COERCION_SENTINELS.has(text.toLowerCase()))
    return `the value is the literal ${JSON.stringify(text)} — a non-value coerced to text, not a real extraction`
  return undefined
}

function description(input: string | null | undefined) {
  if (!input) return undefined
  const text = input.replace(/\s+/g, " ").trim()
  if (text.length <= MAX_DESCRIPTION_LENGTH) return text
  return text.slice(0, MAX_DESCRIPTION_LENGTH - 3) + "..."
}

// Exported so a standalone consumer (the expert gateway process, which has no Effect/Bus context)
// can turn its own drizzle rows into the same redacted Summary/Info shapes the in-process tool uses.
export function toInfo(row: Row): Info {
  const value = decodeValue(row.value)
  return {
    name: Name.make(row.name),
    description: description(row.description),
    value,
    type: valueType(value),
    size: valueText(value).length,
    preview: preview(value),
  }
}

export function toSummary(row: Row): Summary {
  const { value: _, ...summary } = toInfo(row)
  return summary
}

function nestedTextValues(value: Value): string[] {
  if (typeof value === "string") return [value, JSON.stringify(value)]
  if (Array.isArray(value)) return value.flatMap((item) => nestedTextValues(item))
  if (value && typeof value === "object") return Object.values(value).flatMap((item) => nestedTextValues(item))
  return []
}

function redactCandidates(value: Value) {
  return [valueText(value), ...nestedTextValues(value)].filter(
    (item, index, items) => item.length >= MIN_REDACT_LENGTH && items.indexOf(item) === index,
  )
}

export class MissingTemplateVariableError extends Error {
  readonly variable: string

  constructor(variable: string) {
    super(`Session variable template {{var:${variable}}} could not be resolved because "${variable}" is not saved.`)
    this.name = "MissingTemplateVariableError"
    this.variable = variable
  }
}

// ── Missing And Corrupt Variables Are Distinct Failures ─────────
// Write-time validation should prevent unusable values from being persisted,
// but legacy rows or an older bypass can still reach template resolution.
// A dedicated error distinguishes that corruption from a name that was never
// saved, allowing callers to request recapture instead of silently substituting it.
// ─────────────────────────────────────────────────────────────────
export class UnusableTemplateVariableError extends Error {
  readonly variable: string
  readonly reason: string

  constructor(variable: string, reason: string) {
    super(
      `Session variable template {{var:${variable}}} resolved to an unusable value: ${reason}. Re-capture "${variable}" with a real value before referencing it.`,
    )
    this.name = "UnusableTemplateVariableError"
    this.variable = variable
    this.reason = reason
  }
}

// Stored variables may deliberately compose other stored variables, but their dependency graph is
// untrusted model input. Report only variable names on failure: values can be credentials or tokens.
export class TemplateVariableCycleError extends Error {
  readonly variables: readonly string[]

  constructor(variables: readonly string[]) {
    super(`Session variable templates contain a cycle: ${variables.join(" -> ")}.`)
    this.name = "TemplateVariableCycleError"
    this.variables = variables
  }
}

export class TemplateVariableDepthError extends Error {
  readonly variables: readonly string[]
  readonly limit = MAX_TEMPLATE_RESOLUTION_DEPTH

  constructor(variables: readonly string[]) {
    super(
      `Session variable template expansion exceeded ${MAX_TEMPLATE_RESOLUTION_DEPTH} nested references: ${variables.join(" -> ")}.`,
    )
    this.name = "TemplateVariableDepthError"
    this.variables = variables
  }
}

function requireTemplateValue(name: string, lookup: (name: string) => Value | undefined) {
  const value = lookup(name)
  if (value === undefined) throw new MissingTemplateVariableError(name)
  const reason = unusableValueReason(value)
  if (reason) throw new UnusableTemplateVariableError(name, reason)
  return value
}

function resolveTemplateValue(
  name: string,
  lookup: (name: string) => Value | undefined,
  variables: readonly string[],
): Value {
  const cycleStart = variables.indexOf(name)
  if (cycleStart >= 0) throw new TemplateVariableCycleError([...variables.slice(cycleStart), name])
  if (variables.length >= MAX_TEMPLATE_RESOLUTION_DEPTH) throw new TemplateVariableDepthError([...variables, name])
  return resolveTemplateReferencesAt(requireTemplateValue(name, lookup), lookup, [...variables, name])
}

function resolveTemplateString(
  text: string,
  lookup: (name: string) => Value | undefined,
  variables: readonly string[],
) {
  const exact = text.match(EXACT_TEMPLATE_PATTERN)
  if (exact?.[1]) return resolveTemplateValue(exact[1], lookup, variables)
  return text.replace(TEMPLATE_PATTERN, (_, name: string) => valueText(resolveTemplateValue(name, lookup, variables)))
}

function resolveTemplateReferencesAt(
  input: Value,
  lookup: (name: string) => Value | undefined,
  variables: readonly string[],
): Value
function resolveTemplateReferencesAt(
  input: Record<string, unknown>,
  lookup: (name: string) => Value | undefined,
  variables: readonly string[],
): Record<string, unknown>
function resolveTemplateReferencesAt(
  input: unknown,
  lookup: (name: string) => Value | undefined,
  variables: readonly string[],
): unknown
function resolveTemplateReferencesAt(
  input: unknown,
  lookup: (name: string) => Value | undefined,
  variables: readonly string[],
): unknown {
  if (typeof input === "string") return resolveTemplateString(input, lookup, variables)
  if (Array.isArray(input)) return input.map((item) => resolveTemplateReferencesAt(item, lookup, variables))
  if (input && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input).map((entry) => [entry[0], resolveTemplateReferencesAt(entry[1], lookup, variables)]),
    )
  }
  return input
}

export function resolveTemplateReferences(input: Value, lookup: (name: string) => Value | undefined): Value
export function resolveTemplateReferences(
  input: Record<string, unknown>,
  lookup: (name: string) => Value | undefined,
): Record<string, unknown>
export function resolveTemplateReferences(input: unknown, lookup: (name: string) => Value | undefined): unknown
export function resolveTemplateReferences(input: unknown, lookup: (name: string) => Value | undefined): unknown {
  return resolveTemplateReferencesAt(input, lookup, [])
}

// ── Final Reports Preserve Visible Unresolved Placeholders ───────
// Tool arguments fail on every missing or unusable variable because executing
// with a bad value is unsafe. Terminal report rendering instead substitutes only
// usable values and leaves each unresolved token visible; losing the deliverable
// would be less useful than an explicit gap. The returned names let the host log
// that degradation without exposing values or silently claiming completeness.
// ─────────────────────────────────────────────────────────────────
export function resolveTemplatesLenient(
  text: string,
  lookup: (name: string) => Value | undefined,
): { text: string; unresolved: string[] } {
  const unresolved: string[] = []
  const resolved = text.replace(TEMPLATE_PATTERN, (match, name: string) => {
    const value = lookup(name)
    if (value === undefined || unusableValueReason(value) !== undefined) {
      unresolved.push(name)
      return match
    }
    return valueText(value)
  })
  return { text: resolved, unresolved: [...new Set(unresolved)] }
}

// ── Leniency Is An Explicit Field Allowlist ──────────────────────
// Action fields stay strict so unresolved variables cannot reach a command,
// path, request, or target. Only known narrative fields may preserve unknown
// placeholders as literal prose. Keeping the exception beside the resolver
// prevents a newly added tool field from inheriting leniency accidentally.
// ─────────────────────────────────────────────────────────────────
export const CONTENT_LENIENT_FIELDS: Record<string, ReadonlySet<string>> = {
  write: new Set(["content"]),
  edit: new Set(["old", "new"]),
  handoff: new Set(["summary"]),
}

export function resolveToolArguments(
  toolID: string,
  args: Record<string, unknown>,
  lookup: (name: string) => Value | undefined,
): { args: Record<string, unknown>; unresolved: string[] } {
  const lenientFields = CONTENT_LENIENT_FIELDS[toolID]
  if (!lenientFields) {
    return { args: resolveTemplateReferences(args, lookup), unresolved: [] }
  }
  const unresolved: string[] = []
  const resolved = Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      if (lenientFields.has(key) && typeof value === "string") {
        const result = resolveTemplatesLenient(value, lookup)
        unresolved.push(...result.unresolved)
        return [key, result.text]
      }
      return [key, resolveTemplateReferences(value, lookup)]
    }),
  )
  return { args: resolved, unresolved: [...new Set(unresolved)] }
}

export function redactText(text: string, variables: Info[]) {
  return variables
    .flatMap((variable) =>
      redactCandidates(variable.value).map((value) => ({
        value,
        replacement: `[redacted:variable:${variable.name}]`,
      })),
    )
    .toSorted((a, b) => b.value.length - a.value.length)
    .reduce((result, item) => result.split(item.value).join(item.replacement), text)
}

export function redactToolInput(input: Record<string, unknown>) {
  if (input.action !== "set" || !("value" in input)) return input
  return {
    ...input,
    value: `[redacted:variable:${typeof input.name === "string" && input.name ? input.name : "value"}]`,
  }
}

export function systemContext(variables: Summary[]) {
  const variableLines =
    variables.length === 0
      ? "- No session variables saved yet."
      : variables
          .map((variable) =>
            [
              `- ${variable.name}`,
              `type=${variable.type}`,
              `size=${variable.size}`,
              variable.description ? `description=${variable.description}` : undefined,
            ]
              .filter((item): item is string => typeof item === "string")
              .join(" "),
          )
          .join("\n")
  return [
    "Session variable store:",
    "- Save long reusable constants, tokens, IDs, request bodies, and structured JSON with the variable tool instead of rewriting them.",
    "- Always reference saved values as {{var:name}} in tool arguments, including shell commands, instead of copying raw values.",
    "- Do not call variable get with reveal:true only to pass a value to another tool. Use the {{var:name}} template instead.",
    "- Saved values may compose other saved values with {{var:name}}. Action arguments expand up to 16 nested references; cycles or deeper chains fail before the tool runs.",
    "- Exact references preserve JSON values; embedded references stringify them.",
    "- Do not copy raw variable values into messages unless you have explicitly revealed them and truly need the literal value.",
    "<session_variables>",
    variableLines,
    "</session_variables>",
  ].join("\n")
}

export type SystemContextSnapshot = {
  readonly userID: MessageID
  readonly context: string
}

export function freezeSystemContextSnapshot(current: SystemContextSnapshot | undefined, next: SystemContextSnapshot) {
  if (current?.userID === next.userID) return current
  return next
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const listRows = (sessionID: SessionID) =>
      Database.use((db) =>
        db
          .select()
          .from(SessionVariableTable)
          .where(eq(SessionVariableTable.session_id, sessionID))
          .orderBy(asc(SessionVariableTable.name))
          .all(),
      )

    const visibleRows = (sessionID: SessionID) => listRows(sessionID).filter((row) => !isHostOwnedName(row.name))

    const publish = Effect.fnUntraced(function* (sessionID: SessionID) {
      yield* bus.publish(Event.Updated, { sessionID, variables: visibleRows(sessionID).map(toSummary) })
    })

    const set: Interface["set"] = Effect.fn("SessionVariable.set")(function* (input) {
      if (isHostOwnedName(input.name)) throw new Error("Host-owned session variables cannot be set by agents.")
      const row = Database.transaction((db) => {
        const current = db
          .select()
          .from(SessionVariableTable)
          .where(and(eq(SessionVariableTable.session_id, input.sessionID), eq(SessionVariableTable.name, input.name)))
          .get()
        const next: Row = {
          session_id: input.sessionID,
          name: input.name,
          source_message_id: input.sourceMessageID ?? current?.source_message_id ?? null,
          description: input.description ?? current?.description ?? null,
          value: input.value,
        }

        if (current) {
          db.update(SessionVariableTable)
            .set({
              source_message_id: next.source_message_id,
              description: next.description,
              value: next.value,
            })
            .where(and(eq(SessionVariableTable.session_id, input.sessionID), eq(SessionVariableTable.name, input.name)))
            .run()
          return next
        }

        db.insert(SessionVariableTable).values(next).run()
        return next
      })
      yield* publish(input.sessionID)
      return toSummary(row)
    })

    const get: Interface["get"] = Effect.fn("SessionVariable.get")(function* (input) {
      if (isHostOwnedName(input.name)) return undefined
      const row = Database.use((db) =>
        db
          .select()
          .from(SessionVariableTable)
          .where(and(eq(SessionVariableTable.session_id, input.sessionID), eq(SessionVariableTable.name, input.name)))
          .get(),
      )
      return row ? toInfo(row) : undefined
    })

    const list: Interface["list"] = Effect.fn("SessionVariable.list")(function* (sessionID) {
      return visibleRows(sessionID).map(toSummary)
    })

    const entries: Interface["entries"] = Effect.fn("SessionVariable.entries")(function* (sessionID) {
      return visibleRows(sessionID).map((row) => ({ name: Name.make(row.name), value: decodeValue(row.value) }))
    })

    const deleteVariable: Interface["delete"] = Effect.fn("SessionVariable.delete")(function* (input) {
      if (isHostOwnedName(input.name)) return false
      const changed = Database.transaction((db) => {
        const row = db
          .select({ name: SessionVariableTable.name })
          .from(SessionVariableTable)
          .where(and(eq(SessionVariableTable.session_id, input.sessionID), eq(SessionVariableTable.name, input.name)))
          .get()
        if (!row) return false
        db.delete(SessionVariableTable)
          .where(and(eq(SessionVariableTable.session_id, input.sessionID), eq(SessionVariableTable.name, input.name)))
          .run()
        return true
      })
      if (changed) yield* publish(input.sessionID)
      return changed
    })

    const resolveTemplates: Interface["resolveTemplates"] = Effect.fn("SessionVariable.resolveTemplates")(
      function* (sessionID, input) {
        const values = new Map(visibleRows(sessionID).map((row) => [row.name, decodeValue(row.value)]))
        return resolveTemplateReferences(input, (name) => values.get(name))
      },
    )

    const resolveToolTemplates: Interface["resolveToolTemplates"] = Effect.fn("SessionVariable.resolveToolTemplates")(
      function* (sessionID, toolID, args) {
        const values = new Map(visibleRows(sessionID).map((row) => [row.name, decodeValue(row.value)]))
        return resolveToolArguments(toolID, args, (name) => values.get(name))
      },
    )

    const redact: Interface["redact"] = Effect.fn("SessionVariable.redact")(function* (sessionID, text) {
      if (!text) return text
      return redactText(text, listRows(sessionID).map(toInfo))
    })

    const system: Interface["system"] = Effect.fn("SessionVariable.system")(function* (sessionID) {
      return systemContext(visibleRows(sessionID).map(toSummary))
    })

    const hostSecret: Interface["hostSecret"] = Effect.fn("SessionVariable.hostSecret")(function* (input) {
      if (!isHostOwnedName(input.name)) throw new Error("Host secrets require a reserved host-owned name.")
      return Database.transaction((db) => {
        const current = db
          .select()
          .from(SessionVariableTable)
          .where(and(eq(SessionVariableTable.session_id, input.sessionID), eq(SessionVariableTable.name, input.name)))
          .get()
        if (typeof current?.value === "string" && current.value.length >= 32) return current.value
        const value = randomBytes(32).toString("base64url")
        const next: Row = {
          session_id: input.sessionID,
          name: input.name,
          source_message_id: null,
          description: "Host-owned workflow attestation secret",
          value,
        }
        if (current) {
          db.update(SessionVariableTable)
            .set({ source_message_id: null, description: next.description, value })
            .where(and(eq(SessionVariableTable.session_id, input.sessionID), eq(SessionVariableTable.name, input.name)))
            .run()
        } else db.insert(SessionVariableTable).values(next).run()
        return value
      })
    })

    const hostValue: Interface["hostValue"] = Effect.fn("SessionVariable.hostValue")(function* (input) {
      if (!isHostOwnedName(input.name)) throw new Error("Host values require a reserved host-owned name.")
      const row = Database.use((db) =>
        db
          .select({ value: SessionVariableTable.value })
          .from(SessionVariableTable)
          .where(and(eq(SessionVariableTable.session_id, input.sessionID), eq(SessionVariableTable.name, input.name)))
          .get(),
      )
      return row ? decodeValue(row.value) : undefined
    })

    return Service.of({
      set,
      get,
      list,
      entries,
      delete: deleteVariable,
      resolveTemplates,
      resolveToolTemplates,
      redact,
      system,
      hostSecret,
      hostValue,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as SessionVariable from "./variable"
