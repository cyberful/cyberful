// ── One-Shot Tool Presentation ───────────────────────────────────
// Reduces completed control-plane tool parts to compact terminal summaries,
// with bounded structured bodies for tools whose output is useful inline.
// → cyberful/src/cli/cmd/run.ts — renders these summaries during one-shot runs.
// ─────────────────────────────────────────────────────────────────

import os from "node:os"
import path from "node:path"
import type { ToolPart } from "@/server/client"
import { SHELL_TOOL_ICON, toolDisplayName } from "../tool-display"

type ToolDict = Record<string, unknown>

type ToolFrame = {
  name: string
  input: ToolDict
  metadata: ToolDict
  state: ToolDict
  status: string
}

type ToolProps = {
  input: ToolDict
  metadata: ToolDict
  frame: ToolFrame
}

export type ToolInline = {
  icon: string
  title: string
  description?: string
  mode?: "inline" | "block"
  body?: string
}

function dict(value: unknown): ToolDict {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : []
}

function toolPath(input: string): string {
  if (!input) return ""
  const cwd = process.cwd()
  const home = os.homedir()
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const relative = path.relative(cwd, absolute)
  if (!relative) return "."
  if (!relative.startsWith("..")) return relative.replaceAll("\\", "/")
  if (home && (absolute === home || absolute.startsWith(home + path.sep)))
    return absolute.replace(home, "~").replaceAll("\\", "/")
  return absolute.replaceAll("\\", "/")
}

function frame(part: ToolPart): ToolFrame {
  const state = dict(part.state)
  return {
    name: part.tool,
    input: dict(state.input),
    metadata: "metadata" in part.state ? dict(part.state.metadata) : {},
    state,
    status: text(state.status),
  }
}

function fallback(props: ToolProps): ToolInline {
  const title =
    text(props.frame.state.title) || (Object.keys(props.input).length > 0 ? JSON.stringify(props.input) : "Unknown")
  return { icon: "⚙", title: `${toolDisplayName(props.frame.name)} ${title}` }
}

const presentations: Record<string, (props: ToolProps) => ToolInline> = {
  invalid: (props) => ({
    icon: "✗",
    title: text(props.frame.state.title) || "Invalid Tool",
    mode: "block",
    body: props.frame.status === "completed" ? text(props.frame.state.output) : undefined,
  }),
  bash: (props) => ({
    icon: SHELL_TOOL_ICON,
    title: text(props.input.command),
    mode: "block",
    body: props.frame.status === "completed" ? text(props.frame.state.output).trim() : undefined,
  }),
  apply_patch: (props) => {
    const files = list(props.metadata.files).length
    return { icon: "%", title: files === 0 ? "Patch" : `Patch ${files} file${files === 1 ? "" : "s"}` }
  },
  batch: (props) => {
    const calls = list(props.input.tool_calls).length
    return {
      icon: "#",
      title: text(props.frame.state.title) || (calls > 0 ? `Batch ${calls} tool${calls === 1 ? "" : "s"}` : "Batch"),
      mode: "block",
      body: props.frame.status === "completed" ? text(props.frame.state.output) : undefined,
    }
  },
  todowrite: (props) => ({
    icon: "#",
    title: "Todos",
    mode: "block",
    body: list<{ status?: string; content?: string }>(props.input.todos)
      .flatMap((item) => {
        const body = text(item?.content)
        if (!body) return []
        const mark = item.status === "completed" ? "[✓]" : item.status === "in_progress" ? "[•]" : "[ ]"
        return [`${mark} ${body}`]
      })
      .join("\n"),
  }),
  question: (props) => {
    const total = list(props.input.questions).length
    return { icon: "→", title: `Asked ${total} question${total === 1 ? "" : "s"}` }
  },
  list: (props) => {
    const directory = text(props.input.path)
    return { icon: "→", title: directory ? `List ${toolPath(directory)}` : "List" }
  },
  webfetch: (props) => {
    const url = text(props.input.url)
    return { icon: "%", title: url ? `WebFetch ${url}` : "WebFetch" }
  },
  skill: (props) => ({ icon: "→", title: `Skill "${text(props.input.name)}"` }),
}

export function toolInlineInfo(part: ToolPart): ToolInline {
  const current = frame(part)
  const props = { input: current.input, metadata: current.metadata, frame: current }
  try {
    return presentations[current.name]?.(props) ?? fallback(props)
  } catch {
    return fallback(props)
  }
}
