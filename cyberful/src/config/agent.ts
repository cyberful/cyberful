// ── Workflow-Scoped Persona Configuration ────────────────────────
// Loads persona presentation from agents/<workflow>/<phase>.md while retaining
//   semantic phase names and collision-free internal catalog keys.
// → cyberful/src/subsystem/phase.ts — owns workflow-scoped runtime resolution.
// ─────────────────────────────────────────────────────────────────

export * as ConfigAgent from "./agent"

import path from "path"
import { Schema } from "effect"
import * as Log from "@/util/log"
import { Glob } from "@/util/glob"
import * as ConfigMarkdown from "./markdown"
import { ConfigParse } from "./parse"
import { NonNegativeInt } from "@/schema"

const log = Log.create({ service: "config" })

const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

// ── Delegation Metadata Does Not Grant Capability ────────────────
// A persona describes product policy and presentation. Its `subagents` value is
// retained as catalog metadata, while the owning runtime decides whether current
// effort and policy can activate delegation. Parsing therefore never treats the
// value as a shared capability grant or a model-provider configuration switch.
// → cyberful/src/subsystem/codex.ts — enforces Codex-specific delegation policy.
// ─────────────────────────────────────────────────────────────────
export const Info = Schema.Struct({
  name: Schema.String,
  workflow: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  hidden: Schema.optional(Schema.Boolean),
  color: Schema.optional(Color),
  subagents: Schema.optional(NonNegativeInt),
}).annotate({ identifier: "AgentConfig" })
export type Info = Schema.Schema.Type<typeof Info>

export async function load(dir: string) {
  const result: Record<string, Info> = {}
  const agentRoot = path.join(dir, "agents")
  for (const item of await Glob.scan("agents/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  }).then((items) => items.toSorted())) {
    const md = await ConfigMarkdown.parse(item).catch((err) => {
      log.error("failed to load persona", { persona: item, err })
      return undefined
    })
    if (!md) continue

    // ── Persona Identity Includes Its Workflow Scope ──────────────
    // Public persona names remain semantic phase names such as `verify` and
    // `report`, but several workflows legitimately reuse those names. The
    // internal catalog key therefore includes the owning workflow directory.
    // Configuration merges can then retain every persona without changing the
    // phase name exposed to prompts, handoffs, or users.
    // ─────────────────────────────────────────────────────────────────
    const name = path.basename(item, path.extname(item))
    const relativeDirectory = path.dirname(path.relative(agentRoot, item))
    const workflow = relativeDirectory === "." ? undefined : relativeDirectory.split(path.sep)[0]
    const catalogID = workflow ? `${workflow}/${name}` : name
    if (result[catalogID]) throw new Error(`Duplicate persona id '${catalogID}' in agents/: ${item}`)
    result[catalogID] = ConfigParse.schema(
      Info,
      { ...md.data, name, ...(workflow ? { workflow } : {}), prompt: md.content.trim() },
      item,
    )
  }
  return result
}
