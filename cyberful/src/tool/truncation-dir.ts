// ── Tool Output Directory Reset ──────────────────────────────────
// Recreates the process-wide overflow directory during synchronous startup so
//   stale tool artifacts cannot leak into a later run's result references.
// → cyberful/src/tool/truncate.ts — writes bounded overflow artifacts here.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import fs from "node:fs"
import { Global } from "@/global"
import * as Log from "@/util/log"

export const TRUNCATION_DIR = path.join(Global.Path.data, "tool-output")
const log = Log.create({ service: "tool.truncation-dir" })

export function emptyTruncationDirSync() {
  try {
    fs.rmSync(TRUNCATION_DIR, { recursive: true, force: true })
    fs.mkdirSync(TRUNCATION_DIR, { recursive: true })
  } catch (error) {
    log.warn("failed to reset tool output directory", { error, directory: TRUNCATION_DIR })
  }
}
