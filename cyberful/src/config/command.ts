// ── Configured Command Discovery ─────────────────────────────────
// Discovers command Markdown files, derives stable nested names, parses their
// frontmatter and templates, and rejects entries outside the command schema.
// → cyberful/src/config/markdown.ts — parses command frontmatter and body text.
// → cyberful/src/config/entry-name.ts — derives the configured command name.
// ─────────────────────────────────────────────────────────────────

export * as ConfigCommand from "./command"

import path from "path"
import * as Log from "@/util/log"
import { Cause, Exit, Schema } from "effect"
import { Glob } from "@/util/glob"
import { configEntryNameFromPath } from "./entry-name"
import { InvalidError } from "./error"
import * as ConfigMarkdown from "./markdown"

const log = Log.create({ service: "config" })

export const Info = Schema.Struct({
  template: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  subtask: Schema.optional(Schema.Boolean),
})

export type Info = Schema.Schema.Type<typeof Info>

const decodeInfo = Schema.decodeUnknownExit(Info)

export async function load(dir: string) {
  const result: Record<string, Info> = {}
  for (const item of await Glob.scan("{command,commands}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch((err) => {
      log.error("failed to load command", { command: item, err })
      return undefined
    })
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["command/", "commands/"])

    const config = {
      name,
      ...md.data,
      template: md.content.trim(),
    }
    const parsed = decodeInfo(config, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(parsed)) {
      result[config.name] = parsed.value
      continue
    }
    throw new InvalidError({ path: item, message: Cause.pretty(parsed.cause) }, { cause: Cause.squash(parsed.cause) })
  }
  return result
}
