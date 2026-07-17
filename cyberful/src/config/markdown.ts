// ── Configuration Markdown Parsing ───────────────────────────────
// Extracts file and shell references and parses Markdown frontmatter, retrying
// only after a narrow repair of unquoted top-level scalars containing colons.
// → cyberful/src/config/agent.ts — validates parsed agent definitions.
// → cyberful/src/config/command.ts — validates parsed command definitions.
// ─────────────────────────────────────────────────────────────────

import { NamedError } from "@/util/error"
import matter from "gray-matter"
import { Schema } from "effect"
import { Filesystem } from "@/util/filesystem"

export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g
export const SHELL_REGEX = /!`([^`]+)`/g

export function files(template: string) {
  return Array.from(template.matchAll(FILE_REGEX))
}

export function shell(template: string) {
  return Array.from(template.matchAll(SHELL_REGEX))
}

// ── Compatibility Repair Is Narrow And Retry-Only ────────────
// Imported agent files may contain colon-bearing plain scalars accepted by
// other authoring tools but rejected by the YAML parser used here. The original
// document is always parsed first; recovery rewrites only eligible top-level
// values as block scalars. A second parser pass remains authoritative, so the
// fallback never turns an otherwise invalid document into unchecked metadata.
// ────────────────────────────────────────────────────────────────
export function fallbackSanitization(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content

  const frontmatter = match[1]
  const lines = frontmatter.split(/\r?\n/)
  const result: string[] = []

  for (const line of lines) {
    if (line.trim().startsWith("#") || line.trim() === "") {
      result.push(line)
      continue
    }

    if (line.match(/^\s+/)) {
      result.push(line)
      continue
    }

    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!kvMatch) {
      result.push(line)
      continue
    }

    const key = kvMatch[1]
    const value = kvMatch[2].trim()

    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) {
      result.push(line)
      continue
    }

    if (value.includes(":")) {
      result.push(`${key}: |-`)
      result.push(`  ${value}`)
      continue
    }

    result.push(line)
  }

  const processed = result.join("\n")
  return content.replace(frontmatter, () => processed)
}

export async function parse(filePath: string) {
  const template = await Filesystem.readText(filePath)

  try {
    const md = matter(template)
    return md
  } catch {
    try {
      return matter(fallbackSanitization(template))
    } catch (err) {
      throw new FrontmatterError(
        {
          path: filePath,
          message: `${filePath}: Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        },
        { cause: err },
      )
    }
  }
}

export const FrontmatterError = NamedError.create("ConfigFrontmatterError", {
  path: Schema.String,
  message: Schema.String,
})

export * as ConfigMarkdown from "./markdown"
