// ── Bun PTY Process Adapter ──────────────────────────────────────
// Adapts the native bun-pty process into Cyberful's minimal process contract
//   without changing argument, environment, event, resize, or signal semantics.
// → cyberful/src/pty/pty.ts — defines the runtime-neutral contract.
// ─────────────────────────────────────────────────────────────────

import { spawn as create } from "bun-pty"
import type { Opts, Proc } from "./pty"

export function spawn(file: string, args: string[], opts: Opts): Proc {
  const pty = create(file, args, opts)
  return {
    pid: pty.pid,
    onData(listener) {
      return pty.onData(listener)
    },
    onExit(listener) {
      return pty.onExit(listener)
    },
    write(data) {
      pty.write(data)
    },
    resize(cols, rows) {
      pty.resize(cols, rows)
    },
    kill(signal) {
      pty.kill(signal)
    },
  }
}
