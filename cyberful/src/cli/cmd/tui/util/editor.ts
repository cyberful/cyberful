// ── External Prompt Editor ───────────────────────────────────────
// Parses VISUAL or EDITOR into explicit process arguments without invoking a
//   shell, exchanges text through an owned temporary directory, and restores
//   rendering on success, editor failure, or cancellation.
// → cyberful/src/util/process.ts — launches the validated argument vector.
// ─────────────────────────────────────────────────────────────────

import { defer } from "@/util/defer"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliRenderer } from "@opentui/core"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"

const EDITOR_COMMAND_LIMIT = 4_096

export function parseEditorCommand(value: string): string[] {
  if (value.length > EDITOR_COMMAND_LIMIT) throw new Error("VISUAL or EDITOR is too long")
  if (value.includes("\0")) throw new Error("VISUAL or EDITOR contains a null byte")

  const args: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let started = false

  const push = () => {
    if (!started) return
    args.push(current)
    current = ""
    started = false
  }

  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (character === undefined) continue

    if (quote) {
      if (character === quote) {
        quote = undefined
        continue
      }
      if (character === "\\" && quote === '"') {
        const next = value[index + 1]
        if (next === '"' || next === "\\") {
          current += next
          index++
          continue
        }
      }
      current += character
      continue
    }

    if (character === "'" || character === '"') {
      quote = character
      started = true
      continue
    }
    if (/\s/.test(character)) {
      push()
      continue
    }
    if (character === "\\") {
      const next = value[index + 1]
      if (next !== undefined && (/\s/.test(next) || next === "'" || next === '"' || next === "\\")) {
        current += next
        started = true
        index++
        continue
      }
    }
    current += character
    started = true
  }

  if (quote) throw new Error("VISUAL or EDITOR contains an unterminated quote")
  push()
  if (args.length === 0 || !args[0]) throw new Error("VISUAL or EDITOR must name an executable")
  return args
}

export async function open(opts: { value: string; renderer: CliRenderer; cwd?: string }): Promise<string | undefined> {
  const editor = process.env["VISUAL"] || process.env["EDITOR"]
  if (!editor) return

  const directory = await mkdtemp(join(tmpdir(), "cyberful-editor-"))
  const filepath = join(directory, "prompt.md")
  await using _ = defer(async () => rm(directory, { force: true, recursive: true }))

  await Filesystem.write(filepath, opts.value)
  opts.renderer.suspend()
  opts.renderer.currentRenderBuffer.clear()
  try {
    const command = parseEditorCommand(editor)
    const proc = Process.spawn([...command, filepath], {
      cwd: opts.cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) throw new Error(`Editor exited with code ${exitCode}`)
    const content = await Filesystem.readText(filepath)
    return content || undefined
  } finally {
    opts.renderer.currentRenderBuffer.clear()
    opts.renderer.resume()
    opts.renderer.requestRender()
  }
}

export * as Editor from "./editor"
