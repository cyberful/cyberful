// ── Windows Console Signal Guard ─────────────────────────────────
// Uses kernel32 console modes to keep Ctrl-C available as TUI input, flush stale
//   events, and restore the original processed-input state during cleanup.
// ─────────────────────────────────────────────────────────────────

import { dlopen, ptr } from "bun:ffi"
import type { ReadStream } from "node:tty"

const STD_INPUT_HANDLE = -10
const ENABLE_PROCESSED_INPUT = 0x0001

const kernel = () =>
  dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "ptr" },
    GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
    SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
    FlushConsoleInputBuffer: { args: ["ptr"], returns: "i32" },
  })

let k32: ReturnType<typeof kernel> | undefined

function load(): ReturnType<typeof kernel> | undefined {
  if (process.platform !== "win32") return
  try {
    k32 ??= kernel()
    return k32
  } catch {
    return
  }
}

/**
 * Clear ENABLE_PROCESSED_INPUT on the console stdin handle.
 */
export function win32DisableProcessedInput() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  const api = load()
  if (!api) return

  const handle = api.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)
  if (api.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return

  const mode = buf[0] ?? 0
  if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
  api.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
}

/**
 * Discard any queued console input (mouse events, key presses, etc.).
 */
export function win32FlushInputBuffer() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  const api = load()
  if (!api) return

  const handle = api.symbols.GetStdHandle(STD_INPUT_HANDLE)
  api.symbols.FlushConsoleInputBuffer(handle)
}

let unhook: (() => void) | undefined

// ── The Guard Reasserts Console-Global Input Ownership ───────────
// Windows converts Ctrl-C into a process-group signal whenever processed input
// is enabled, and runtimes may restore that console-global flag on a later tick.
// Wrapping known raw-mode changes handles the normal path while a low-frequency
// unref'ed poll covers native or external changes. Cleanup removes both owners
// and restores the exact mode observed before the guard was installed.
// ─────────────────────────────────────────────────────────────────
export function win32InstallCtrlCGuard() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  const api = load()
  if (!api) return
  if (unhook) return unhook

  // A truthy `isTTY` is Node's runtime proof that stdin implements tty.ReadStream.
  const stdin = process.stdin as ReadStream
  const original = stdin.setRawMode

  const handle = api.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)

  if (api.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return
  const initial = buf[0] ?? 0

  const enforce = () => {
    if (api.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return
    const mode = buf[0] ?? 0
    if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
    api.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
  }

  // Some runtimes can re-apply console modes on the next tick; enforce twice.
  const later = () => {
    enforce()
    setImmediate(enforce)
  }

  let wrapped: ReadStream["setRawMode"] | undefined

  if (typeof original === "function") {
    wrapped = (mode: boolean) => {
      const result = original.call(stdin, mode)
      later()
      return result
    }

    stdin.setRawMode = wrapped
  }

  // Ensure it's cleared immediately too (covers any earlier mode changes).
  later()

  const interval = setInterval(enforce, 100)
  interval.unref()

  let done = false
  unhook = () => {
    if (done) return
    done = true

    clearInterval(interval)
    if (wrapped && stdin.setRawMode === wrapped) {
      stdin.setRawMode = original
    }

    api.symbols.SetConsoleMode(handle, initial)
    unhook = undefined
  }

  return unhook
}
