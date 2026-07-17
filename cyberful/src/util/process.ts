// ── Cancellable Subprocess Adapter ───────────────────────────────
// Spawns argument-array commands, owns abort escalation and exit observation,
// and captures bounded stdout and stderr for local utility integrations.
// → cyberful/src/format/formatter.ts — probes formatter capabilities through this adapter.
// → cyberful/src/cli/cmd/tui/util/editor.ts — owns interactive editor child cleanup.
// ─────────────────────────────────────────────────────────────────

import { type ChildProcess } from "node:child_process"
import launch from "cross-spawn"
import type { Readable } from "node:stream"
import { errorMessage } from "./error"

export type Stdio = "inherit" | "pipe" | "ignore"
export type Shell = boolean | string

export interface Options {
  cwd?: string
  env?: NodeJS.ProcessEnv | null
  stdin?: Stdio
  stdout?: Stdio
  stderr?: Stdio
  shell?: Shell
  abort?: AbortSignal
  kill?: NodeJS.Signals | number
  timeout?: number
}

export interface RunOptions extends Omit<Options, "stdout" | "stderr"> {
  nothrow?: boolean
  maxOutputBytes?: number
}

export interface Result {
  code: number
  stdout: Buffer
  stderr: Buffer
}

export interface TextResult extends Result {
  text: string
}

export class RunFailedError extends Error {
  readonly cmd: string[]
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: Buffer

  constructor(cmd: string[], code: number, stdout: Buffer, stderr: Buffer) {
    const text = stderr.toString().trim()
    super(
      text
        ? `Command failed with code ${code}: ${cmd.join(" ")}\n${text}`
        : `Command failed with code ${code}: ${cmd.join(" ")}`,
    )
    this.name = "ProcessRunFailedError"
    this.cmd = [...cmd]
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
  }
}

export type Child = ChildProcess & { exited: Promise<number> }

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024

async function readLimited(stream: Readable, limit: number, abort: () => void) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("maxOutputBytes must be a positive safe integer")
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > limit) {
      abort()
      throw new Error(`Process output exceeded ${limit} bytes`)
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

export function spawn(cmd: string[], opts: Options = {}): Child {
  if (cmd.length === 0) throw new Error("Command is required")
  opts.abort?.throwIfAborted()

  const proc = launch(cmd[0], cmd.slice(1), {
    cwd: opts.cwd,
    shell: opts.shell,
    env: opts.env === null ? {} : opts.env ? { ...process.env, ...opts.env } : undefined,
    stdio: [opts.stdin ?? "ignore", opts.stdout ?? "ignore", opts.stderr ?? "ignore"],
    windowsHide: process.platform === "win32",
  })

  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const abort = () => {
    if (closed) return
    if (proc.exitCode !== null || proc.signalCode !== null) return
    closed = true

    proc.kill(opts.kill ?? "SIGTERM")

    const ms = opts.timeout ?? 5_000
    if (ms <= 0) return
    timer = setTimeout(() => proc.kill("SIGKILL"), ms)
  }

  const exited = new Promise<number>((resolve, reject) => {
    const done = () => {
      opts.abort?.removeEventListener("abort", abort)
      if (timer) clearTimeout(timer)
    }

    proc.once("exit", (code, signal) => {
      done()
      resolve(code ?? (signal ? 1 : 0))
    })

    proc.once("error", (error) => {
      done()
      reject(error)
    })
  })
  if (opts.abort) {
    opts.abort.addEventListener("abort", abort, { once: true })
    if (opts.abort.aborted) abort()
  }

  return Object.assign(proc, { exited })
}

export async function run(cmd: string[], opts: RunOptions = {}): Promise<Result> {
  const proc = spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin,
    shell: opts.shell,
    abort: opts.abort,
    kill: opts.kill,
    timeout: opts.timeout,
    stdout: "pipe",
    stderr: "pipe",
  })

  if (!proc.stdout || !proc.stderr) throw new Error("Process output not available")

  const stopCapture = () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL")
  }
  const outputLimit = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  // ── Capture Failure Still Reaps The Subprocess ──────────────────
  // A stream can exceed its memory budget or fail before the child exits. The
  // first such failure kills the child, but returning immediately would leave
  // exit observation and the other pipe detached. Settling all three fixed
  // owners guarantees the process is reaped and both streams close before the
  // caller receives either the translated result or the original failure.
  // ─────────────────────────────────────────────────────────────────
  const [exit, stdout, stderr] = await Promise.allSettled([
    proc.exited,
    readLimited(proc.stdout, outputLimit, stopCapture),
    readLimited(proc.stderr, outputLimit, stopCapture),
  ])
  if (exit.status === "rejected" || stdout.status === "rejected" || stderr.status === "rejected") {
    const failures = [exit, stdout, stderr].flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    const errors = failures.map((failure) => (failure instanceof Error ? failure : new Error(errorMessage(failure))))
    const failure = errors.length === 1 ? errors[0] : new AggregateError(errors, "subprocess observation failed")
    if (!failure) throw new Error("subprocess observation failed without a reported cause")
    if (!opts.nothrow) throw failure
    return {
      code: exit.status === "fulfilled" ? exit.value : 1,
      stdout: stdout.status === "fulfilled" ? stdout.value : Buffer.alloc(0),
      stderr: stderr.status === "fulfilled" ? stderr.value : Buffer.from(errorMessage(failure)),
    }
  }
  const out = {
    code: exit.value,
    stdout: stdout.value,
    stderr: stderr.value,
  }
  if (out.code === 0 || opts.nothrow) return out
  throw new RunFailedError(cmd, out.code, out.stdout, out.stderr)
}

export async function text(cmd: string[], opts: RunOptions = {}): Promise<TextResult> {
  const out = await run(cmd, opts)
  return {
    ...out,
    text: out.stdout.toString(),
  }
}

export * as Process from "./process"
