// ── Dedicated TUI Configuration Migration ───────────────────────
// Moves terminal-only keys from legacy Cyberful config files into `tui.json`
//   per directory while preserving files that already own dedicated settings.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { type ParseError as JsoncParseError, applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import { unique } from "remeda"
import { Option, Schema } from "effect"
import { DiffStyle, ScrollAcceleration, ScrollSpeed } from "./tui-schema"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import * as Log from "@/util/log"
import * as ConfigPaths from "@/config/paths"

const log = Log.create({ service: "tui.migrate" })

const TUI_SCHEMA_URL = "https://cyberful.ai/tui.json"

const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const decodeScrollSpeed = Schema.decodeUnknownOption(ScrollSpeed)
const decodeScrollAcceleration = Schema.decodeUnknownOption(ScrollAcceleration)
const decodeDiffStyle = Schema.decodeUnknownOption(DiffStyle)

interface MigrateInput {
  cwd: string
  directories: string[]
}

// ── Existing TUI Files Own Their Configuration ───────────────────
// Migration scans every applicable legacy configuration independently because
// project and user scopes may each contain terminal settings. A pre-existing
// `tui.json` is authoritative for its directory and is never merged or replaced.
// The legacy file is edited only after a dedicated destination is written, so a
// failed read, parse, or write cannot silently discard the original settings.
// ─────────────────────────────────────────────────────────────────
export async function migrateTuiConfig(input: MigrateInput) {
  const cyberful = await cyberfulFiles(input)
  for (const file of cyberful) {
    const source = await Filesystem.readText(file).catch((error) => {
      log.warn("failed to read config for tui migration", { path: file, error })
      return undefined
    })
    if (!source) continue
    const errors: JsoncParseError[] = []
    const data = parseJsonc(source, errors, { allowTrailingComma: true })
    if (errors.length || !data || typeof data !== "object" || Array.isArray(data)) continue

    const hadTheme = "theme" in data
    const keybinds = decodeRecord("keybinds" in data ? data.keybinds : undefined)
    const legacyTui = decodeRecord("tui" in data ? data.tui : undefined)
    const extracted = {
      keybinds: Option.getOrUndefined(keybinds),
      tui: Option.getOrUndefined(legacyTui),
    }
    const tui = extracted.tui ? normalizeTui(extracted.tui) : undefined
    if (!hadTheme && extracted.keybinds === undefined && !tui) continue

    const target = path.join(path.dirname(file), "tui.json")
    const targetExists = await Filesystem.exists(target)
    if (targetExists) continue

    const payload: Record<string, unknown> = {
      $schema: TUI_SCHEMA_URL,
    }
    if (extracted.keybinds !== undefined) payload.keybinds = extracted.keybinds
    if (tui) Object.assign(payload, tui)

    const wrote = await Filesystem.write(target, JSON.stringify(payload, null, 2))
      .then(() => true)
      .catch((error) => {
        log.warn("failed to write tui migration target", { from: file, to: target, error })
        return false
      })
    if (!wrote) continue

    const stripped = await backupAndStripLegacy(file, source)
    if (!stripped) {
      log.warn("tui config migrated but source file was not stripped", { from: file, to: target })
      continue
    }
    log.info("migrated tui config", { from: file, to: target })
  }
}

function normalizeTui(data: Record<string, unknown>):
  | {
      scroll_speed: number | undefined
      scroll_acceleration: { enabled: boolean } | undefined
      diff_style: "auto" | "stacked" | undefined
    }
  | undefined {
  const parsed = {
    scroll_speed: Option.getOrUndefined(decodeScrollSpeed(data.scroll_speed)),
    scroll_acceleration: Option.getOrUndefined(decodeScrollAcceleration(data.scroll_acceleration)),
    diff_style: Option.getOrUndefined(decodeDiffStyle(data.diff_style)),
  }
  return parsed.scroll_speed === undefined &&
    parsed.diff_style === undefined &&
    parsed.scroll_acceleration === undefined
    ? undefined
    : parsed
}

async function backupAndStripLegacy(file: string, source: string) {
  const backup = file + ".tui-migration.bak"
  const hasBackup = await Filesystem.exists(backup)
  const backed = hasBackup
    ? true
    : await Filesystem.write(backup, source)
        .then(() => true)
        .catch((error) => {
          log.warn("failed to backup source config during tui migration", { path: file, backup, error })
          return false
        })
  if (!backed) return false

  const text = ["theme", "keybinds", "tui"].reduce((acc, key) => {
    const edits = modify(acc, [key], undefined, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    if (!edits.length) return acc
    return applyEdits(acc, edits)
  }, source)

  return Filesystem.write(file, text)
    .then(() => {
      log.info("stripped tui keys from server config", { path: file, backup })
      return true
    })
    .catch((error) => {
      log.warn("failed to strip legacy tui keys from server config", { path: file, backup, error })
      return false
    })
}

async function cyberfulFiles(input: { directories: string[]; cwd: string }) {
  const files = [
    ...ConfigPaths.fileInDirectory(Global.Path.config, "cyberful"),
    ...(await Filesystem.findUp(["cyberful.json", "cyberful.jsonc"], input.cwd, undefined, { rootFirst: true })),
  ]
  for (const dir of unique(input.directories)) {
    files.push(...ConfigPaths.fileInDirectory(dir, "cyberful"))
  }
  if (Flag.CYBERFUL_CONFIG) files.push(Flag.CYBERFUL_CONFIG)

  const existing = await Promise.all(
    unique(files).map(async (file) => {
      const ok = await Filesystem.exists(file)
      return ok ? file : undefined
    }),
  )
  return existing.filter((file): file is string => !!file)
}
