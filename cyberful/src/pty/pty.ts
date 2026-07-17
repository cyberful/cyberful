// ── PTY Process Contract ─────────────────────────────────────────
// Defines the process, event subscription, launch environment, resize, and
//   termination surface implemented by the active pseudo-terminal adapter.
// ─────────────────────────────────────────────────────────────────

export type Disp = {
  dispose(): void
}

export type Exit = {
  exitCode: number
  signal?: number | string
}

export type Opts = {
  name: string
  cols?: number
  rows?: number
  cwd?: string
  env?: Record<string, string>
}

export type Proc = {
  pid: number
  onData(listener: (data: string) => void): Disp
  onExit(listener: (event: Exit) => void): Disp
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}
