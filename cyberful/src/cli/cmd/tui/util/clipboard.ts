// ── Cross-Platform Clipboard Boundary ────────────────────────────
// Reads and writes text or image clipboard data through ordered platform-native
//   commands and a lazy library fallback while keeping subprocess arguments split.
// ─────────────────────────────────────────────────────────────────

import fs from "node:fs/promises"
import { platform, release, tmpdir } from "node:os"
import path from "node:path"
import { lazy } from "../../../../util/lazy.js"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@/effect/process"
import * as Filesystem from "../../../../util/filesystem"
import * as Process from "../../../../util/process"
import * as Log from "@/util/log"

const log = Log.create({ service: "tui.clipboard" })
const MAX_CLIPBOARD_BYTES = 16 * 1024 * 1024
const MAX_OSC52_BYTES = 100_000

const writeWithStdin = (cmd: string[], text: string): Promise<void> => {
  const [command, ...args] = cmd
  if (!command) return Promise.reject(new Error("Clipboard command is required"))
  return Effect.runPromise(
    AppProcess.Service.use((svc) => svc.run(ChildProcess.make(command, args), { stdin: text })).pipe(
      Effect.provide(AppProcess.defaultLayer),
      Effect.flatMap(AppProcess.requireSuccess),
      Effect.asVoid,
    ),
  )
}

const getWhich = lazy(async () => {
  const { which } = await import("../../../../util/which")
  return which
})

const getClipboardy = lazy(async () => {
  const { default: clipboardy } = await import("clipboardy")
  return clipboardy
})

function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) return
  if (Buffer.byteLength(text, "utf8") > MAX_OSC52_BYTES) {
    log.debug("clipboard text exceeds OSC 52 transport limit", { maxBytes: MAX_OSC52_BYTES })
    return
  }
  const base64 = Buffer.from(text).toString("base64")
  const osc52 = `\x1b]52;c;${base64}\x07`
  const passthrough = process.env["TMUX"] || process.env["STY"]
  const sequence = passthrough ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52
  process.stdout.write(sequence)
}

export interface Content {
  data: string
  mime: string
}

// ── Clipboard Images Take Priority Over Text ─────────────────────
// Terminals surface image paste through different signals: forwarded Ctrl-V,
// empty bracketed-paste hints, or a Kitty key release. Each path may call this
// boundary, so it probes image formats first and falls back to text only after
// every platform image route declines. Temporary image files remain owned by
// the probe and are removed before it returns.
// ─────────────────────────────────────────────────────────────────
export async function read(): Promise<Content | undefined> {
  const os = platform()

  if (os === "darwin") {
    const tmpfile = path.join(tmpdir(), `cyberful-clipboard-${crypto.randomUUID()}.png`)
    try {
      const result = await Process.run(
        [
          "osascript",
          "-e",
          "on run argv",
          "-e",
          'set imageData to the clipboard as "PNGf"',
          "-e",
          "set fileRef to open for access POSIX file (item 1 of argv) with write permission",
          "-e",
          "set eof fileRef to 0",
          "-e",
          "write imageData to fileRef",
          "-e",
          "close access fileRef",
          "-e",
          "end run",
          tmpfile,
        ],
        { nothrow: true },
      )
      if (result.code !== 0) throw new Error("macOS clipboard does not contain a PNG image")
      const info = await fs.stat(tmpfile)
      if (info.size > MAX_CLIPBOARD_BYTES) throw new Error(`Clipboard image exceeds ${MAX_CLIPBOARD_BYTES} bytes`)
      const buffer = await Filesystem.readBytes(tmpfile)
      return { data: buffer.toString("base64"), mime: "image/png" }
    } catch (error) {
      log.debug("macOS clipboard image probe declined", { error })
    } finally {
      await fs.rm(tmpfile, { force: true }).catch((error) => {
        log.warn("failed to remove temporary clipboard image", { error, tmpfile })
      })
    }
  }

  // Windows/WSL: probe clipboard for images via PowerShell.
  // Bracketed paste can't carry image data so we read it directly.
  if (os === "win32" || release().includes("WSL")) {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }"
    const base64 = await Process.text(["powershell.exe", "-NonInteractive", "-NoProfile", "-command", script], {
      nothrow: true,
    })
    if (base64.text) {
      const imageBuffer = Buffer.from(base64.text.trim(), "base64")
      if (imageBuffer.length > 0) {
        return { data: imageBuffer.toString("base64"), mime: "image/png" }
      }
    }
  }

  if (os === "linux") {
    const wayland = await Process.run(["wl-paste", "-t", "image/png"], { nothrow: true })
    if (wayland.stdout.byteLength > 0) {
      return { data: Buffer.from(wayland.stdout).toString("base64"), mime: "image/png" }
    }
    const x11 = await Process.run(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"], {
      nothrow: true,
    })
    if (x11.stdout.byteLength > 0) {
      return { data: Buffer.from(x11.stdout).toString("base64"), mime: "image/png" }
    }
  }

  const clipboardy = await getClipboardy()
  const text = await clipboardy.read().catch((error) => {
    log.debug("clipboard text read failed", { error })
    return undefined
  })
  if (text) {
    if (Buffer.byteLength(text, "utf8") > MAX_CLIPBOARD_BYTES) {
      log.warn("clipboard text exceeds paste limit", { maxBytes: MAX_CLIPBOARD_BYTES })
      return undefined
    }
    return { data: text, mime: "text/plain" }
  }
}

const getCopyMethod = lazy(async () => {
  const os = platform()
  const which = await getWhich()

  if (os === "darwin" && which("pbcopy")) {
    log.debug("using pbcopy clipboard integration")
    return (text: string) => writeWithStdin(["pbcopy"], text)
  }

  if (os === "linux") {
    if (process.env["WAYLAND_DISPLAY"] && which("wl-copy")) {
      log.debug("using wl-copy clipboard integration")
      return (text: string) => writeWithStdin(["wl-copy"], text)
    }
    if (which("xclip")) {
      log.debug("using xclip clipboard integration")
      return (text: string) => writeWithStdin(["xclip", "-selection", "clipboard"], text)
    }
    if (which("xsel")) {
      log.debug("using xsel clipboard integration")
      return (text: string) => writeWithStdin(["xsel", "--clipboard", "--input"], text)
    }
  }

  if (os === "win32") {
    log.debug("using PowerShell clipboard integration")
    return (text: string) =>
      // Pipe via stdin to avoid PowerShell string interpolation ($env:FOO, $(), etc.)
      writeWithStdin(
        [
          "powershell.exe",
          "-NonInteractive",
          "-NoProfile",
          "-Command",
          "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
        ],
        text,
      )
  }

  log.debug("using clipboard library fallback")
  return async (text: string) => {
    const clipboardy = await getClipboardy()
    await clipboardy.write(text)
  }
})

export async function copy(text: string): Promise<void> {
  writeOsc52(text)
  const method = await getCopyMethod()
  await method(text)
}

export * as Clipboard from "./clipboard"
