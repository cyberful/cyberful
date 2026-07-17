// ── Tool Heading Presentation ────────────────────────────────────
// Converts validated tool input into bounded, human-readable names, summaries,
//   and details for CLI and TUI activity feeds.
// ─────────────────────────────────────────────────────────────────

import { Option, Schema } from "effect"

export const CYBERFUL_OS_TOOL_ID = "cyberful-os_shell"
export const SHELL_TOOL_ICON = "\uea85"

export type ToolDisplayInput = Record<string, unknown> | string | undefined

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const DETAIL_LIMIT = 120
const VALUE_LIMIT = 80
type ToolDetailBuilder = (record: Record<string, unknown>) => string

const TOOL_DETAIL_BUILDERS: Record<string, ToolDetailBuilder> = {
  get_powerful_tools: (record) => details([field(record, "keyword"), field(record, "name"), field(record, "limit")]),
  bash: shellDetails,
  shell: shellDetails,
  [CYBERFUL_OS_TOOL_ID]: shellDetails,
  read: readDetails,
  write: fileMutationDetails,
  edit: fileMutationDetails,
  glob: searchDetails,
  grep: searchDetails,
  list: (record) => details([field(record, "path")]),
  webfetch: (record) => details([bare(record, "url")]),
  skill: (record) => details([field(record, "name")]),
  task: (record) => details([field(record, "subagent_type", "agent"), bare(record, "description")]),
  todowrite: todoDetails,
  question: questionDetails,
  variable: (record) => details([field(record, "action"), field(record, "name")]),
}

export function toolDisplayName(name: string) {
  if (name === CYBERFUL_OS_TOOL_ID) return "cyberful-os"
  if (name === "get_powerful_tools") return "Discover tools"
  return name
}

export function toolDisplayText(name: string, details = "") {
  const label = toolDisplayName(name)
  if (!details) return label
  return `${label} ${details}`
}

export function toolDisplaySummary(name: string, input?: ToolDisplayInput) {
  return toolDisplayText(name, toolDisplayDetails(name, input))
}

export function toolDisplayDetails(name: string, input?: ToolDisplayInput) {
  const record = toolInputRecord(input)
  return shorten((TOOL_DETAIL_BUILDERS[name] ?? primitiveDetails)(record), DETAIL_LIMIT)
}

export function toolInputRecord(input?: ToolDisplayInput): Record<string, unknown> {
  if (!input) return {}
  if (isRecord(input)) return input
  const decoded = Option.getOrUndefined(decodeJson(input))
  return isRecord(decoded) ? decoded : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function details(items: Array<string | undefined>) {
  return items.filter((item): item is string => Boolean(item)).join(" ")
}

function shorten(value: string, limit: number) {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`
}

function stringValue(record: Record<string, unknown>, key: string) {
  const value = record[key]
  if (typeof value === "string") return value.trim() || undefined
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}

function bare(record: Record<string, unknown>, key: string) {
  const value = stringValue(record, key)
  return value ? shorten(value.replace(/\s+/g, " "), VALUE_LIMIT) : undefined
}

function field(record: Record<string, unknown>, key: string, label = key) {
  const value = bare(record, key)
  if (!value) return undefined
  return `${label}=${quote(value)}`
}

function quote(value: string) {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value
  return `"${value.replaceAll('"', '\\"')}"`
}

function primitiveDetails(record: Record<string, unknown>) {
  return details(
    Object.keys(record)
      .slice(0, 3)
      .map((key) => field(record, key)),
  )
}

function shellDetails(record: Record<string, unknown>) {
  return details([bare(record, "command") ?? bare(record, "description"), field(record, "workdir")])
}

function readDetails(record: Record<string, unknown>) {
  return details([field(record, "filePath", "file"), field(record, "offset"), field(record, "limit")])
}

function fileMutationDetails(record: Record<string, unknown>) {
  return details([
    field(record, "path", "file") ?? field(record, "filePath", "file"),
    field(record, "line"),
    field(record, "tag"),
    field(record, "lines"),
  ])
}

function searchDetails(record: Record<string, unknown>) {
  return details([field(record, "pattern"), field(record, "path")])
}

function todoDetails(record: Record<string, unknown>) {
  const todos = record.todos
  if (!Array.isArray(todos)) return primitiveDetails(record)
  return `${todos.length} todo${todos.length === 1 ? "" : "s"}`
}

function questionDetails(record: Record<string, unknown>) {
  const questions = record.questions
  if (!Array.isArray(questions)) return primitiveDetails(record)
  return `${questions.length} question${questions.length === 1 ? "" : "s"}`
}
