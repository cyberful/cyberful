// ── Managed System Configuration ─────────────────────────────────
// Locates administrator-owned config and converts macOS managed preference plists
// into Cyberful JSON after removing mobile-profile metadata.
// → cyberful/src/config/config.ts — merges managed content into runtime config.
// ─────────────────────────────────────────────────────────────────

export * as ConfigManaged from "./managed"

import { existsSync } from "fs"
import os from "os"
import path from "path"
import * as Log from "@/util/log"
import { Process } from "@/util/process"
import { isRecord } from "@/util/record"

const log = Log.create({ service: "config" })

const MANAGED_PLIST_DOMAIN = "ai.cyberful.managed"

// Keys injected by macOS/MDM into the managed plist that are not Cyberful config
const PLIST_META = new Set([
  "PayloadDisplayName",
  "PayloadIdentifier",
  "PayloadType",
  "PayloadUUID",
  "PayloadVersion",
  "_manualProfile",
])

function systemManagedConfigDir(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/cyberful"
    case "win32":
      return path.join(process.env.ProgramData || "C:\\ProgramData", "cyberful")
    default:
      return "/etc/cyberful"
  }
}

export function managedConfigDir() {
  return process.env.CYBERFUL_TEST_MANAGED_CONFIG_DIR || systemManagedConfigDir()
}

export function parseManagedPlist(json: string): string {
  const raw: unknown = JSON.parse(json)
  if (!isRecord(raw)) throw new TypeError("Managed preferences must decode to a JSON object")
  for (const key of Object.keys(raw)) {
    if (PLIST_META.has(key)) delete raw[key]
  }
  return JSON.stringify(raw)
}

export async function readManagedPreferences() {
  if (process.platform !== "darwin") return

  const user = os.userInfo().username
  const paths = [
    path.join("/Library/Managed Preferences", user, `${MANAGED_PLIST_DOMAIN}.plist`),
    path.join("/Library/Managed Preferences", `${MANAGED_PLIST_DOMAIN}.plist`),
  ]

  for (const plist of paths) {
    if (!existsSync(plist)) continue
    log.info("reading macOS managed preferences", { path: plist })
    const result = await Process.run(["plutil", "-convert", "json", "-o", "-", plist], { nothrow: true })
    if (result.code !== 0) {
      log.warn("failed to convert managed preferences plist", { path: plist })
      continue
    }
    return {
      source: `mobileconfig:${plist}`,
      text: parseManagedPlist(result.stdout.toString()),
    }
  }

  return
}
