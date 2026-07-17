// ── Bounded Browser Artifact Writer ─────────────────────────────────
// Streams one browser download into the engagement artifacts directory with
// fixed byte and time limits. Browser-provided names are reduced to a basename,
// output is assembled in a private temporary file, and only a complete artifact
// is atomically promoted. Failed or oversized downloads leave no partial file.
// → mcps/browser/browser_mcp.mjs — serializes download events through this writer.
// ─────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import { mkdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`)
  return value
}

function safeDownloadName(value) {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) {
    throw new Error("browser download supplied an invalid filename")
  }
  const name = path.posix.basename(value.replaceAll("\\", "/"))
  if (!name || name === "." || name === "..") throw new Error("browser download supplied an invalid filename")
  return name
}

export async function saveBrowserDownload(download, options) {
  const maxBytes = positiveSafeInteger(options.maxBytes, "maxBytes")
  const timeoutMs = positiveSafeInteger(options.timeoutMs, "timeoutMs")
  const name = safeDownloadName(download.suggestedFilename())
  await mkdir(options.artifactsDir, { recursive: true })

  const target = path.join(options.artifactsDir, name)
  const temporary = path.join(options.artifactsDir, `.${randomUUID()}.download`)
  const source = await download.createReadStream()
  if (!source) throw new Error(`browser download ${name} has no readable stream`)

  let bytes = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.byteLength
      if (bytes > maxBytes) {
        callback(new Error(`browser download ${name} exceeded the ${maxBytes}-byte artifact limit`))
        return
      }
      callback(null, chunk)
    },
  })
  const controller = new AbortController()
  const timeoutError = new Error(`browser download ${name} exceeded its ${timeoutMs}ms deadline`)
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs)
  timer.unref?.()

  try {
    await pipeline(source, limiter, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }), {
      signal: controller.signal,
    })
    await rename(temporary, target)
    return { bytes, name, target }
  } catch (error) {
    const failure = controller.signal.aborted ? timeoutError : error
    try {
      await rm(temporary, { force: true })
    } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], `browser download ${name} cleanup failed`)
    }
    throw failure
  } finally {
    clearTimeout(timer)
  }
}
