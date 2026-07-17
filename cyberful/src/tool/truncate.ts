// ── Bounded Tool Output Storage ──────────────────────────────────
// Applies configured line and byte limits to tool results, persists complete
//   overflow artifacts, and returns a directional preview with its local path.
// ─────────────────────────────────────────────────────────────────

import { NodePath } from "@effect/platform-node"
import { Effect, Layer, Option, Context } from "effect"
import path from "node:path"
import type { Agent } from "../agent/agent"
import { AppFileSystem } from "@/effect/filesystem"
import { Config } from "@/config/config"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"
import * as Log from "@/util/log"

export const MAX_LINES = 500
export const MAX_BYTES = 16 * 1024 // 16KiB
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail"
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string) => Effect.Effect<string>
  /**
   * Returns output unchanged when it fits within the limits, otherwise writes the full text
   * to the truncation directory and returns a preview plus a hint to inspect the saved file.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
  /**
   * Resolved truncation limits: values from `tool_output` in cyberful config, or MAX_LINES / MAX_BYTES if unset.
   */
  readonly limits: () => Effect.Effect<{ maxLines: number; maxBytes: number }>
}

export class Service extends Context.Service<Service, Interface>()("@cyberful/Truncate") {}

const log = Log.create({ service: "tool.truncate" })

function positiveLimit(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

export function buildTruncatedPreview(
  text: string,
  options: { maxLines: number; maxBytes: number; direction: "head" | "tail" },
): { preview: string; removed: number; unit: "bytes" | "lines" } | undefined {
  const maxLines = positiveLimit(options.maxLines, MAX_LINES)
  const maxBytes = positiveLimit(options.maxBytes, MAX_BYTES)
  const lines = text.split("\n")
  const totalBytes = Buffer.byteLength(text, "utf-8")
  if (lines.length <= maxLines && totalBytes <= maxBytes) return

  const selected: string[] = []
  let bytes = 0
  let hitBytes = false

  if (options.direction === "head") {
    for (const line of lines.slice(0, maxLines)) {
      const size = Buffer.byteLength(line, "utf-8") + (selected.length > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      selected.push(line)
      bytes += size
    }
  } else {
    for (let index = lines.length - 1; index >= 0 && selected.length < maxLines; index--) {
      const line = lines[index]
      if (line === undefined) continue
      const size = Buffer.byteLength(line, "utf-8") + (selected.length > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      selected.unshift(line)
      bytes += size
    }
  }

  return {
    preview: selected.join("\n"),
    removed: hitBytes ? totalBytes - bytes : lines.length - selected.length,
    unit: hitBytes ? "bytes" : "lines",
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      yield* fs.remove(TRUNCATION_DIR, { recursive: true }).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
        Effect.orDie,
      )
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
    })

    const write = Effect.fn("Truncate.write")(function* (text: string) {
      const file = path.join(TRUNCATION_DIR, ToolID.ascending())
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      return file
    })

    const limits = Effect.fn("Truncate.limits")(function* () {
      const configSvc = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(configSvc)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const cfg = yield* configSvc.value.get().pipe(
        Effect.catch((error) => {
          log.warn("failed to read tool output limits", { error })
          return Effect.succeed(undefined)
        }),
      )
      return {
        maxLines: positiveLimit(cfg?.tool_output?.max_lines, MAX_LINES),
        maxBytes: positiveLimit(cfg?.tool_output?.max_bytes, MAX_BYTES),
      }
    })

    // ── Truncation Preserves The Complete Result Off-Card ─────────
    // Line and UTF-8 byte ceilings are independent; crossing either selects a
    // directional preview but never mutates the original result. The full text
    // is persisted before the truncated card is returned, and that card names
    // the local artifact plus the exact quantity removed. Invalid programmatic
    // limits fall back to the finite configured defaults instead of disabling
    // output bounds through zero, negative, fractional, or non-finite values.
    // ─────────────────────────────────────────────────────────────────
    const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, _agent?: Agent.Info) {
      const resolved = yield* limits()
      const direction = options.direction ?? "head"
      const truncated = buildTruncatedPreview(text, {
        maxLines: positiveLimit(options.maxLines, resolved.maxLines),
        maxBytes: positiveLimit(options.maxBytes, resolved.maxBytes),
        direction,
      })
      if (!truncated) return { content: text, truncated: false } as const
      const file = yield* write(text)

      const hint = `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nYou can inspect the full file yourself with Grep or Read using offset/limit to navigate specific sections.`

      return {
        content:
          direction === "head"
            ? `${truncated.preview}\n\n...${truncated.removed} ${truncated.unit} truncated...\n\n${hint}`
            : `...${truncated.removed} ${truncated.unit} truncated...\n\n${hint}\n\n${truncated.preview}`,
        truncated: true,
        outputPath: file,
      } as const
    })

    return Service.of({ cleanup, write, output, limits })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(NodePath.layer))

export * as Truncate from "./truncate"
