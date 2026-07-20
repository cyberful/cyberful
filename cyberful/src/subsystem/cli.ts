// ── Agentic Subsystem Process And App-Server Ownership ───────────
// Runs one Codex subprocess, its bidirectional app-server protocol, host dynamic
// tools, structured failure capture, process-tree cleanup, private gateway, and
// owner-only native skill projection. Local fallback sessions reuse this owner
// with a different provider binding rather than creating an untracked model path.
// → cyberful/src/subsystem/provider.ts — supplies provider-specific argv and environment deltas.
// → cyberful/src/util/bounded-output.ts — bounds retained provider streams.
// @docs/runtimes/fallback-inference.md
// ─────────────────────────────────────────────────────────────────

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { Readable } from "node:stream"
import path from "node:path"
import os from "node:os"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { rm } from "node:fs/promises"
import type { DynamicTool, Provider, ProviderFailure, SubsystemRunSpec } from "./provider"
import { sanitizeMarkdownArtifacts } from "./sanitize"
import { SubsystemCodex } from "./codex"
import { SubsystemCodexControl } from "./codex-control"
import {
  approvalElicitationContent,
  approvalElicitationSchema,
  isQuestionRejected,
  parseApprovalElicitationMetadata,
  type AskHuman,
  type HumanQuestion,
} from "./human-question"
import type { Controller as ApprovalController } from "./approval-state"
import * as Log from "@/util/log"
import { BoundedByteTail } from "@/util/bounded-output"

const log = Log.create({ service: "subsystem-cli" })

function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function nodeErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

async function sanitizationWarning(input: RunInput) {
  if (input.spec.permission.kind === "readonly" || !input.spec.markdownArtifacts?.length) return undefined
  try {
    await sanitizeMarkdownArtifacts(input.spec.cwd, input.spec.markdownArtifacts)
    return undefined
  } catch (error) {
    return `Markdown sanitization failed: ${errorDetail(error)}`
  }
}

function withWarning(stderr: string, warning?: string) {
  return [stderr, warning].filter(Boolean).join("\n")
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  termination?: RunTermination
  failureReason?: string
  failure?: ProviderFailure
}

export type RunTermination = "completed" | "budget_exhausted" | "shutdown" | "spawn_failed" | "provider_failed"

export interface RunInput {
  provider: Provider
  spec: SubsystemRunSpec
  // The Codex executable resolved on PATH.
  command: string
  // Delivered on stdin for one-shot calls, or as the app-server turn/start input for a live phase.
  prompt: string
  timeoutMs: number
  // Caller-scoped cancellation kills only this detached process group; host shutdown still uses killAll()
  // for every tracked run.
  abort?: AbortSignal
  // Phase runs bind the app-server turn to the owning cyberful session. This enables live human steering;
  // non-phase Expert calls omit it and retain the one-shot CLI path.
  sessionID?: string
  // Used by both Codex's native request_user_input request and gateway MCP elicitation.
  askQuestion?: AskHuman
  // One phase-owned gate pauses the process budget for every blocking human decision.
  approvalState?: ApprovalController
  dynamicTools?: readonly DynamicTool[]
}

// ── Reap Expert Subprocesses When The Host Closes ─────────────────────
// Codex and its gateway descendants are awaited by a plain Promise, outside an
// Effect scope, so TUI cancellation cannot interrupt them automatically. Each CLI
// therefore leads a detached process group tracked by the host shutdown funnel.
// Cleanup signals the whole group, awaits exit, escalates survivors, and retains a
// synchronous process-exit backstop. A shutdown latch also rejects late arrivals,
// preventing a racing producer from orphaning a process after cleanup begins.
// ──────────────────────────────────────────────────────────────────────

interface SpawnedProc {
  readonly pid: number
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  signalCode: NodeJS.Signals | null
  stopReason?: "budget_exhausted" | "shutdown" | "cancelled"
  // A spawn-level failure message (most often ENOENT: the CLI is not installed) which arrives via the
  // child's async 'error', not on stderr; run()/runStreaming() surface it so the failed run keeps its reason.
  spawnError?: string
  writeStdin(value: string): Promise<void>
  endStdin(): void
  lifecycle: Promise<void>
  cleanup?: () => Promise<void>
  skillRoots?: readonly string[]
  releaseApprovalPause?: () => void
}

const live = new Set<SpawnedProc>()
const CODEX_SETTINGS_ATTESTATION_TIMEOUT_MS = 5_000
const PROCESS_TREE_CLEANUP_TIMEOUT_MS = 5_000
const PROCESS_TREE_CLEANUP_OUTPUT_BYTES = 64 * 1024
const PROVIDER_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024
const PROVIDER_NDJSON_LINE_LIMIT_BYTES = 8 * 1024 * 1024
let exitHookInstalled = false
let shuttingDown = false

let liveListener: ((pids: number[]) => void) | undefined

// Register the host's mirror listener (worker.ts bridges it to the main process over Rpc). One listener.
export function onLiveChange(listener: (pids: number[]) => void): void {
  liveListener = listener
  notifyLive()
}

// The pids of the currently tracked detached group leaders (a failed spawn's -1 is excluded).
export function livePids(): number[] {
  const pids: number[] = []
  for (const p of live) if (p.pid > 1) pids.push(p.pid)
  return pids
}

function notifyLive(): void {
  liveListener?.(livePids())
}

function track<T extends SpawnedProc>(proc: T): T {
  if (shuttingDown) {
    proc.lifecycle = reapTrees([proc], "shutdown")
    return proc
  }
  live.add(proc)
  notifyLive()
  proc.lifecycle = proc.exited.then(
    () => {
      if (live.delete(proc)) notifyLive()
    },
    () => {
      if (live.delete(proc)) notifyLive()
    },
  )
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.once("exit", () => {
      for (const p of live) killTree(p.pid, "SIGKILL")
    })
  }
  return proc
}

function onceAsync(operation: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => (pending ??= operation())
}

export function killTree(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 1) return
  try {
    if (process.platform === "win32") {
      const result = Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "pipe",
        timeout: PROCESS_TREE_CLEANUP_TIMEOUT_MS,
        maxBuffer: PROCESS_TREE_CLEANUP_OUTPUT_BYTES,
      })
      if (result.exitCode !== 0) log.warn("taskkill could not reap Expert process tree", { pid, signal })
    } else {
      process.kill(-pid, signal)
    }
  } catch (error) {
    if (nodeErrorCode(error) !== "ESRCH") log.warn("could not signal Expert process tree", { pid, signal, error })
  }
}

// Reap a set of Expert subprocess groups: SIGTERM each so the CLI can unwind its own children, then
// SIGKILL any survivor after a short grace, dropping each from the live registry. Shared by killAll() (the
// whole registry) and track() (one proc that raced a shutdown already begun).
async function reapTrees(procs: readonly SpawnedProc[], reason: "shutdown"): Promise<void> {
  if (procs.length === 0) return
  for (const p of procs) {
    p.stopReason ??= reason
    p.releaseApprovalPause?.()
    killTree(p.pid, "SIGTERM")
  }
  const graceful = await Promise.all(
    procs.map((proc) =>
      beforeTimeout(
        proc.exited.then(() => true),
        300,
        false,
      ),
    ),
  )
  const survivors = procs.filter((_, index) => !graceful[index])
  for (const proc of survivors) killTree(proc.pid, "SIGKILL")
  const killed = await Promise.all(
    survivors.map((proc) =>
      beforeTimeout(
        proc.exited.then(() => true),
        2_000,
        false,
      ),
    ),
  )
  const unreaped = survivors.filter((_, index) => !killed[index])
  const exited = procs.filter((proc) => !unreaped.includes(proc))
  let changed = false
  for (const proc of exited) changed = live.delete(proc) || changed
  if (changed) notifyLive()
  const cleanup = await Promise.allSettled(exited.flatMap((proc) => (proc.cleanup ? [proc.cleanup()] : [])))
  const cleanupErrors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (unreaped.length > 0)
    cleanupErrors.unshift(
      new Error(`Expert process groups did not exit after SIGKILL: ${unreaped.map((p) => p.pid).join(", ")}`),
    )
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Expert process-tree cleanup failed")
}

export async function killAll(): Promise<void> {
  shuttingDown = true
  for (let round = 0; round < 10 && live.size > 0; round++) {
    await reapTrees(Array.from(live), "shutdown")
  }
  if (live.size > 0) throw new Error(`Could not reap ${live.size} Expert process group(s) during shutdown`)
}

// Test-only: clear the shutdown latch between cases. The in-process suite calls killAll() repeatedly,
// and the latch is otherwise permanent by design. Not part of the runtime contract.
export function resetForTests(): void {
  shuttingDown = false
}

// Number of Expert subprocesses currently in flight — exposed for the lifecycle test.
export function liveCount(): number {
  return live.size
}

function spawnCli(input: RunInput): SpawnedProc {
  const privateDirectory = input.spec.mcpServer?.privateEnv
    ? mkdtempSync(path.join(os.tmpdir(), "cyberful-mcp-env-"))
    : undefined
  if (privateDirectory) chmodSync(privateDirectory, 0o700)
  try {
    const { args, extraEnv } = input.provider.buildArgs(
      privateDirectory ? materializePrivateMcpEnvironment(input.spec, privateDirectory) : input.spec,
    )
    const env: Record<string, string | undefined> = { ...process.env, ...extraEnv }
    const child = nodeSpawn(input.command, args, {
      cwd: input.spec.cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    })
    const proc = adaptChild(child, input.prompt, input.timeoutMs, input.abort, input.approvalState)
    if (privateDirectory) proc.cleanup = onceAsync(() => rm(privateDirectory, { recursive: true, force: true }))
    return track(proc)
  } catch (error) {
    if (privateDirectory) rmSync(privateDirectory, { recursive: true, force: true })
    throw error
  }
}

interface SkillFrontmatter {
  name: string
  description: string
  keywords: string[]
  body: string
}

function parseSkill(source: string): SkillFrontmatter | undefined {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return undefined
  const frontmatter = match[1] ?? ""
  const name = frontmatter.match(/^name:\s*(.+?)\s*$/m)?.[1]?.trim()
  const description = frontmatter.match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim()
  if (!name || !description) return undefined
  const keywordBlock = frontmatter.match(/^keywords:\s*\r?\n((?:\s+-\s+.*(?:\r?\n|$))*)/m)?.[1] ?? ""
  const keywords = [...keywordBlock.matchAll(/^\s+-\s+(.+?)\s*$/gm)].map((item) => item[1] ?? "").filter(Boolean)
  return { name, description, keywords, body: match[2] ?? "" }
}

function nativeSkillName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

function copyNativeSkillPackage(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const destinationPath = path.join(destination, entry.name)
    if (entry.isDirectory()) {
      copyNativeSkillPackage(sourcePath, destinationPath)
      continue
    }
    if (!entry.isFile()) continue
    writeFileSync(destinationPath, readFileSync(sourcePath), { mode: 0o600 })
  }
}

// ── Native Packages Preserve Progressive Disclosure ──────────────
// Built-in security playbooks are native skill directories whose references
// must remain separate from SKILL.md so Codex loads only the relevant catalog.
// Legacy tool contracts remain flat Markdown because they are also consumed by
// host tests and commands. The projection accepts both forms, normalizes their
// discovery directory, rejects duplicate names, and never follows symlinks.
//
// ─────────────────────────────────────────────────────────────────
function prepareCodexSkills(codexHome: string, roots: readonly string[] | undefined): string[] {
  if (!roots?.length) return []
  const destination = path.join(codexHome, "cyberful-skills")
  const used = new Set<string>()
  let count = 0
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const packagedSkill = entry.isDirectory() ? path.join(root, entry.name, "SKILL.md") : undefined
      const flatSkill = entry.isFile() && entry.name.endsWith(".md") ? path.join(root, entry.name) : undefined
      const sourceSkill = packagedSkill && existsSync(packagedSkill) ? packagedSkill : flatSkill
      if (!sourceSkill) continue
      const parsed = parseSkill(readFileSync(sourceSkill, "utf8"))
      if (!parsed) continue
      const name = nativeSkillName(parsed.name || path.basename(entry.name, ".md"))
      if (!name || used.has(name)) continue
      used.add(name)
      const directory = path.join(destination, name)
      if (packagedSkill) {
        copyNativeSkillPackage(path.dirname(packagedSkill), directory)
        count++
        continue
      }
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const triggers = parsed.keywords.slice(0, 8)
      const discovery = triggers.length
        ? `${parsed.description} Use when work involves ${triggers.join(", ")}.`
        : parsed.description
      writeFileSync(
        path.join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${JSON.stringify(discovery)}\n---\n\n${parsed.body}`,
        { mode: 0o600 },
      )
      count++
    }
  }
  return count > 0 ? [destination] : []
}

// Codex MCP configuration is visible in the app-server process arguments. Keep only a non-secret path
// there; the gateway reads the 0600 JSON file directly, while the model process never inherits its values.
export function materializePrivateMcpEnvironment(spec: SubsystemRunSpec, directory: string): SubsystemRunSpec {
  if (!spec.mcpServer?.privateEnv) return spec
  const file = path.join(directory, "gateway-environment.json")
  writeFileSync(file, JSON.stringify(spec.mcpServer.privateEnv), { mode: 0o600 })
  return {
    ...spec,
    mcpServer: {
      ...spec.mcpServer,
      env: { ...spec.mcpServer.env, CYBERFUL_SUBSYSTEM_ENV_PATH: file },
      privateEnv: undefined,
    },
  }
}

function spawnCodexAppServer(input: RunInput): SpawnedProc {
  // ── App-Server Inherits Authentication, Not Personal Policy ─────────
  // App-server has no ignore-user-config switch, so each run receives a fresh
  // owner-only Codex home. Authentication is linked rather than copied, while
  // personal configuration, plugins, and MCP registrations stay outside the
  // phase runtime. Cyberful skills are projected explicitly and the whole home
  // is removed by the process finalizer after app-server exits.
  // ──────────────────────────────────────────────────────────────
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "cyberful-codex-home-"))
  chmodSync(codexHome, 0o700)
  const auth = path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"), "auth.json")
  if (existsSync(auth)) symlinkSync(auth, path.join(codexHome, "auth.json"))
  try {
    const built = input.provider.buildAppServerArgs(materializePrivateMcpEnvironment(input.spec, codexHome))
    const skillRoots = prepareCodexSkills(codexHome, input.spec.skillRoots)
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...built.extraEnv,
      CODEX_HOME: codexHome,
    }
    const child = nodeSpawn(input.command, built.args, {
      cwd: input.spec.cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    })
    const proc = adaptChildProcess(child, input.timeoutMs, input.abort, input.approvalState)
    proc.cleanup = onceAsync(() => rm(codexHome, { recursive: true, force: true }))
    proc.skillRoots = skillRoots
    return track(proc)
  } catch (error) {
    rmSync(codexHome, { recursive: true, force: true })
    throw error
  }
}

// ── Child Adaptation Preserves Exit Cause And Tree Ownership ─────────
// The adapter exposes web streams and one normalized exit promise for normal,
// signaled, and asynchronous spawn failures. Budget and cancellation signals
// target the detached process group, because a child-only timeout would orphan
// gateway descendants. Early stdin EPIPE is expected when spawn fails; any other
// stdin error remains logged rather than crashing or disappearing silently.
// ─────────────────────────────────────────────────────────────
function adaptChildProcess(
  child: ChildProcess,
  timeoutMs: number,
  abort?: AbortSignal,
  approvalState?: ApprovalController,
): SpawnedProc {
  if (!child.stdout || !child.stderr) {
    child.kill()
    throw new Error("Expert process must expose piped stdout and stderr")
  }
  child.stdin?.on("error", (error) => {
    if (!["EPIPE", "ERR_STREAM_DESTROYED"].includes(nodeErrorCode(error) ?? ""))
      log.warn("Expert process stdin failed", { error })
  })
  const proc: SpawnedProc = {
    pid: child.pid ?? -1,
    // Node's stream/web ReadableStream and the global one differ only in nominal typing; the runtime
    // object is a real web stream (verified) that Response()/consumeNdjson consume, so cast through unknown.
    stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>,
    signalCode: null,
    lifecycle: Promise.resolve(),
    writeStdin: (value) =>
      new Promise((resolve, reject) => {
        if (!child.stdin || child.stdin.destroyed) return reject(new Error("Expert process stdin is closed"))
        child.stdin.write(value, (error) => (error ? reject(error) : resolve()))
      }),
    endStdin: () => child.stdin?.end(),
    exited: new Promise<number>((resolve) => {
      // A spawn failure (ENOENT and friends) surfaces as an async 'error' AND a 'close' with a negative
      // libuv code (-2 for ENOENT), in either order. Either path funnels through failed(): keep the 127
      // "not runnable" contract over the platform code, and record a reason so stderr is never empty.
      const failed = (message: string) => {
        if (!proc.spawnError) proc.spawnError = message
        resolve(127)
      }
      child.once("error", (err) => failed(err instanceof Error ? err.message : String(err)))
      child.once("close", (code, signal) => {
        proc.signalCode = signal
        if (code != null && code < 0) return failed(`spawn failed (code ${code})`)
        resolve(code ?? (signal ? 128 : 0))
      })
    }),
  }
  if (timeoutMs > 0 && child.pid) {
    const pid = child.pid
    let remainingMs = timeoutMs
    let activeSince = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let suspended = false
    let released = false

    const clearBudgetTimer = () => {
      if (!timer) return
      clearTimeout(timer)
      timer = undefined
    }
    const expire = () => {
      timer = undefined
      proc.stopReason ??= "budget_exhausted"
      proc.signalCode = "SIGKILL"
      killTree(pid, "SIGKILL")
    }
    const arm = () => {
      activeSince = performance.now()
      timer = setTimeout(expire, Math.max(0, remainingMs))
      timer.unref?.()
    }
    const suspend = () => {
      if (released || suspended) return
      remainingMs = Math.max(0, remainingMs - Math.max(0, performance.now() - activeSince))
      clearBudgetTimer()
      suspended = true
      if (process.platform !== "win32") killTree(pid, "SIGSTOP")
    }
    const resume = () => {
      if (released || !suspended) return
      if (process.platform !== "win32") killTree(pid, "SIGCONT")
      suspended = false
      arm()
    }
    arm()
    const unsubscribe = approvalState?.subscribe((snapshot) => {
      if (snapshot.pending) suspend()
      else resume()
    })
    const release = () => {
      if (released) return
      released = true
      unsubscribe?.()
      clearBudgetTimer()
      if (suspended && process.platform !== "win32") killTree(pid, "SIGCONT")
      suspended = false
    }
    proc.releaseApprovalPause = release
    child.once("close", release)
  }
  if (abort && child.pid) {
    const pid = child.pid
    const cancel = () => {
      proc.stopReason ??= abort.reason === "budget_exhausted" ? "budget_exhausted" : "cancelled"
      proc.signalCode = "SIGTERM"
      proc.releaseApprovalPause?.()
      killTree(pid, "SIGTERM")
      const force = setTimeout(() => {
        proc.signalCode = "SIGKILL"
        killTree(pid, "SIGKILL")
      }, 300)
      force.unref?.()
      child.once("close", () => clearTimeout(force))
    }
    if (abort.aborted) cancel()
    else {
      abort.addEventListener("abort", cancel, { once: true })
      child.once("close", () => abort.removeEventListener("abort", cancel))
    }
  }
  return proc
}

function adaptChild(
  child: ChildProcess,
  prompt: string,
  timeoutMs: number,
  abort?: AbortSignal,
  approvalState?: ApprovalController,
): SpawnedProc {
  const proc = adaptChildProcess(child, timeoutMs, abort, approvalState)
  child.stdin?.end(prompt)
  return proc
}

// Only the phase timer is a timeout. Host shutdown and caller cancellation use the same group-kill
// mechanism but remain separate causes, so UI/transcripts do not misreport an intentional close as spent budget.
const wasTimedOut = (proc: SpawnedProc) => proc.stopReason === "budget_exhausted"

function terminationOf(proc: SpawnedProc, exitCode: number): RunTermination {
  if (proc.stopReason === "cancelled") return "provider_failed"
  if (proc.stopReason) return proc.stopReason
  if (proc.spawnError) return "spawn_failed"
  return exitCode === 0 ? "completed" : "provider_failed"
}

// ── Stream Failure Cannot Bypass Process Reaping ───────────────────
// A failed spawn can reject its adapted output streams before its exit event
// supplies the authoritative diagnostic. Text draining therefore degrades to an
// empty or partial bounded tail and lets the caller await exited, remove the
// process from the live registry, and surface spawnError. This fallback applies
// only to diagnostics; process termination and cleanup remain mandatory and
// observable. Successful reads drain the pipe but retain only its final window.
// ──────────────────────────────────────────────────────────────
async function drainText(
  stream: ReadableStream<Uint8Array>,
): Promise<{ text: string; truncated: boolean; error?: unknown }> {
  const output = new BoundedByteTail(PROVIDER_OUTPUT_LIMIT_BYTES)
  const reader = stream.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      output.append(next.value)
    }
    return { text: output.text(), truncated: output.truncated }
  } catch (error) {
    // A failed spawn rejects both adapted streams; spawnError is the authoritative diagnostic returned
    // by run(), so this fallback prevents a duplicate warning without erasing the user-visible reason.
    return { text: output.text(), truncated: output.truncated, error }
  } finally {
    reader.releaseLock()
  }
}

function truncationWarning(stream: "output" | "error", truncated: boolean) {
  if (!truncated) return
  return `Expert ${stream} exceeded ${PROVIDER_OUTPUT_LIMIT_BYTES} bytes; only the final window was retained.`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    )
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]))
  )
}

type RpcID = string | number

interface RpcPending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const TURN_STEER_RPC_TIMEOUT_MS = 8_000

function appServerQuestions(value: unknown): { ids: string[]; questions: HumanQuestion[] } | undefined {
  if (!Array.isArray(value)) return undefined
  const ids: string[] = []
  const questions: HumanQuestion[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string") return undefined
    if (typeof item.header !== "string" || typeof item.question !== "string") return undefined
    const options = Array.isArray(item.options)
      ? item.options.flatMap((option) =>
          isRecord(option) && typeof option.label === "string" && typeof option.description === "string"
            ? [{ label: option.label, description: option.description }]
            : [],
        )
      : []
    ids.push(item.id)
    questions.push({
      header: item.header,
      question: item.question,
      options,
      custom: item.isOther !== false,
    })
  }
  return { ids, questions }
}

async function beforeTimeout<T>(operation: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function stopAppServer(proc: SpawnedProc): Promise<number> {
  proc.releaseApprovalPause?.()
  proc.endStdin()
  const graceful = await beforeTimeout(
    proc.exited.then((exitCode) => ({ exitCode })),
    500,
    undefined,
  )
  if (graceful) {
    await proc.lifecycle
    await proc.cleanup?.()
    return graceful.exitCode
  }
  killTree(proc.pid, "SIGTERM")
  const terminated = await beforeTimeout(
    proc.exited.then((exitCode) => ({ exitCode })),
    500,
    undefined,
  )
  if (terminated) {
    await proc.lifecycle
    await proc.cleanup?.()
    return terminated.exitCode
  }
  killTree(proc.pid, "SIGKILL")
  const exitCode = await proc.exited
  await proc.lifecycle
  await proc.cleanup?.()
  return exitCode
}

// ── App-Server RPC Is Owned For The Whole Active Turn ──────────────
// Unlike one-shot exec, app-server keeps a bidirectional JSON-RPC transport open
// so steering targets the exact active thread and turn. Pending requests, native
// server requests, and process-exit observation are all retained by this run and
// settled before its temporary home is removed. Notifications stay verbatim in
// stdout so transcript persistence and activity mapping share one source.
// ──────────────────────────────────────────────────────────────
async function runCodexAppServer(input: RunInput, onEvent?: (event: unknown) => void): Promise<RunResult> {
  let proc: SpawnedProc | undefined
  let unregister: (() => void) | undefined
  let exitObservation: Promise<void> | undefined
  const serverRequests = new Set<Promise<void>>()
  const serverRequestAbort = new AbortController()
  const questionSignal = input.abort
    ? AbortSignal.any([input.abort, serverRequestAbort.signal])
    : serverRequestAbort.signal
  const settleServerRequests = async () => {
    serverRequestAbort.abort(new Error("Codex app-server is stopping"))
    await Promise.all([...serverRequests])
  }
  try {
    proc = spawnCodexAppServer(input)
    const activeProc = proc
    const pending = new Map<RpcID, RpcPending>()
    let requestID = 0
    let activeThreadID: string | undefined
    let activeTurnID: string | undefined
    let awaitingTurnSettings = false
    let settingsSettled = false
    let settleSettings: (value: SubsystemCodex.ThreadSettings | { error: string }) => void = () => {}
    const settingsAttestation = new Promise<SubsystemCodex.ThreadSettings | { error: string }>((resolve) => {
      settleSettings = resolve
    })
    const settleAttestation = (value: SubsystemCodex.ThreadSettings | { error: string }) => {
      if (settingsSettled) return
      settingsSettled = true
      settleSettings(value)
    }
    let completedTurn: Record<string, unknown> | undefined
    let completeTurn: (turn: Record<string, unknown> | undefined) => void = () => {}
    const turnCompleted = new Promise<Record<string, unknown> | undefined>((resolve) => {
      completeTurn = resolve
    })

    const send = (value: unknown) => activeProc.writeStdin(`${JSON.stringify(value)}\n`)
    const request = async (method: string, params: unknown, timeoutMs?: number): Promise<unknown> => {
      const id = ++requestID
      const response = Promise.withResolvers<unknown>()
      const timeout = timeoutMs
        ? setTimeout(() => {
            if (!pending.delete(id)) return
            response.reject(new Error(`${method} was not acknowledged within ${timeoutMs}ms`))
          }, timeoutMs)
        : undefined
      timeout?.unref?.()
      pending.set(id, {
        resolve: (value) => {
          if (timeout) clearTimeout(timeout)
          response.resolve(value)
        },
        reject: (error) => {
          if (timeout) clearTimeout(timeout)
          response.reject(error)
        },
      })
      try {
        await send({ id, method, params })
      } catch (error) {
        const wait = pending.get(id)
        if (wait) {
          pending.delete(id)
          wait.reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
      return response.promise
    }
    const respond = (id: RpcID, result: unknown) => send({ id, result })
    const respondError = (id: RpcID, message: string) => send({ id, error: { code: -32000, message } })

    const handleServerRequest = async (message: Record<string, unknown>) => {
      const id = message.id
      if ((typeof id !== "string" && typeof id !== "number") || typeof message.method !== "string") return
      if (message.method === "mcpServer/elicitation/request") {
        if (!isRecord(message.params)) return respondError(id, "Codex supplied invalid elicitation parameters")
        const params = message.params
        if (params.serverName !== "expert-gateway")
          return respondError(id, "Elicitation did not originate from the active Cyberful gateway")
        if (!activeThreadID || params.threadId !== activeThreadID)
          return respondError(id, "Elicitation does not belong to the active Cyberful thread")
        if (!activeTurnID || params.turnId !== activeTurnID)
          return respondError(id, "Elicitation does not belong to the active Cyberful turn")
        if (params.mode !== "form") return respondError(id, "Cyberful accepts only standard MCP form elicitation")
        const questions = parseApprovalElicitationMetadata(params._meta)
        if (!questions) return respondError(id, "Elicitation contains an invalid Cyberful approval envelope")
        if (!sameJson(params.requestedSchema, approvalElicitationSchema(questions)))
          return respondError(id, "Elicitation form does not match its Cyberful approval envelope")
        if (!input.askQuestion) return respond(id, { action: "cancel", content: null, _meta: null })
        try {
          const answers = await input.askQuestion(questions, questionSignal)
          const content = approvalElicitationContent(questions, answers)
          if (!content) return respondError(id, "Human selector returned invalid answers")
          return respond(id, { action: "accept", content, _meta: null })
        } catch (error) {
          if (isQuestionRejected(error)) return respond(id, { action: "decline", content: null, _meta: null })
          if (questionSignal.aborted) return respond(id, { action: "cancel", content: null, _meta: null })
          return respondError(id, error instanceof Error ? error.message : String(error))
        }
      }
      if (message.method === "item/tool/requestUserInput" && input.askQuestion && isRecord(message.params)) {
        const parsed = appServerQuestions(message.params.questions)
        if (!parsed) return respondError(id, "Codex supplied an invalid human question payload")
        try {
          const answers = await input.askQuestion(parsed.questions, questionSignal)
          return respond(id, {
            answers: Object.fromEntries(
              parsed.ids.map((questionID, index) => [questionID, { answers: answers[index] ?? [] }]),
            ),
          })
        } catch (error) {
          return respondError(id, error instanceof Error ? error.message : String(error))
        }
      }
      if (message.method === "item/tool/call") {
        if (!isRecord(message.params)) return respondError(id, "Codex supplied invalid dynamic tool parameters")
        const params = message.params
        if (!activeThreadID || params.threadId !== activeThreadID)
          return respondError(id, "Dynamic tool call does not belong to the active Cyberful thread")
        if (!activeTurnID || params.turnId !== activeTurnID)
          return respondError(id, "Dynamic tool call does not belong to the active Cyberful turn")
        if (typeof params.callId !== "string" || typeof params.tool !== "string")
          return respondError(id, "Dynamic tool call is missing its identity")
        const tool = input.dynamicTools?.find((candidate) => candidate.definition.name === params.tool)
        if (!tool) return respondError(id, `Unknown Cyberful dynamic tool: ${params.tool}`)
        try {
          const output = await tool.execute(params.arguments, { signal: questionSignal })
          const bounded = Buffer.from(output.text, "utf8").subarray(0, 16 * 1024).toString("utf8")
          return respond(id, {
            success: output.success,
            contentItems: [{ type: "inputText", text: bounded }],
          })
        } catch (error) {
          return respond(id, {
            success: false,
            contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }],
          })
        }
      }
      if (message.method === "item/commandExecution/requestApproval") return respond(id, { decision: "decline" })
      if (message.method === "item/fileChange/requestApproval") return respond(id, { decision: "decline" })
      if (message.method === "execCommandApproval" || message.method === "applyPatchApproval")
        return respond(id, { decision: "denied" })
      return respondError(id, `Unsupported app-server request: ${message.method}`)
    }

    const stdout = consumeNdjson(proc.stdout, (event) => {
      if (!isRecord(event)) return
      if ((typeof event.id === "string" || typeof event.id === "number") && !event.method) {
        const wait = pending.get(event.id)
        if (!wait) return
        pending.delete(event.id)
        if (isRecord(event.error)) {
          wait.reject(new Error(typeof event.error.message === "string" ? event.error.message : "Codex RPC failed"))
        } else {
          wait.resolve(event.result)
        }
        return
      }
      if (event.method && event.id !== undefined) {
        let task: Promise<void>
        task = Promise.resolve()
          .then(() => handleServerRequest(event))
          .catch((error) => {
            if (!serverRequestAbort.signal.aborted)
              log.warn("Codex app-server request failed", { method: event.method, error })
          })
          .finally(() => serverRequests.delete(task))
        serverRequests.add(task)
        return
      }
      if (
        event.method === "turn/started" &&
        isRecord(event.params) &&
        event.params.threadId === activeThreadID &&
        isRecord(event.params.turn) &&
        typeof event.params.turn.id === "string"
      )
        activeTurnID = event.params.turn.id
      const settings = SubsystemCodex.threadSettings(event)
      if (awaitingTurnSettings && settings) settleAttestation(settings)
      if (awaitingTurnSettings && !settingsSettled && isOperationalCodexEvent(event))
        settleAttestation({ error: "Codex began operational activity before attesting its resolved settings." })
      if (event.method) onEvent?.(event)
      if (event.method !== "turn/completed" || !isRecord(event.params) || !isRecord(event.params.turn)) return
      if (activeThreadID && event.params.threadId !== activeThreadID) return
      completedTurn = event.params.turn
      completeTurn(completedTurn)
    })
    const stderr = drainText(proc.stderr)
    exitObservation = proc.exited.then(() => {
      serverRequestAbort.abort(new Error(proc?.spawnError ?? "Codex app-server exited"))
      for (const wait of pending.values()) wait.reject(new Error(proc?.spawnError ?? "Codex app-server exited"))
      pending.clear()
      completeTurn(undefined)
    })

    await request("initialize", {
      clientInfo: { name: "cyberful", title: "cyberful Codex phase runtime", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: false },
    })
    await send({ method: "initialized" })
    if (proc.skillRoots?.length) {
      await request("skills/extraRoots/set", { extraRoots: proc.skillRoots })
    }
    const threadResult = await request("thread/start", {
      model: input.spec.model ?? null,
      baseInstructions: input.spec.baseInstructions ?? null,
      developerInstructions: input.spec.developerInstructions ?? null,
      dynamicTools: input.dynamicTools?.map((tool) => tool.definition) ?? input.spec.dynamicTools ?? null,
      cwd: input.spec.cwd,
      runtimeWorkspaceRoots: [input.spec.cwd],
      approvalPolicy: {
        granular: {
          sandbox_approval: false,
          rules: false,
          skill_approval: false,
          request_permissions: false,
          mcp_elicitations: true,
        },
      },
      sandbox: input.spec.permission.kind === "readonly" ? "read-only" : "workspace-write",
      ephemeral: true,
    })
    if (!isRecord(threadResult) || !isRecord(threadResult.thread) || typeof threadResult.thread.id !== "string")
      throw new Error("Codex app-server did not return a thread id")
    activeThreadID = threadResult.thread.id
    const requestedEffort = SubsystemCodex.effort()
    awaitingTurnSettings = true
    const turnResult = await request("turn/start", {
      threadId: activeThreadID,
      input: [{ type: "text", text: input.prompt }],
      model: input.spec.model ?? null,
      effort: requestedEffort,
    })
    if (!isRecord(turnResult) || !isRecord(turnResult.turn) || typeof turnResult.turn.id !== "string")
      throw new Error("Codex app-server did not return a turn id")
    if (activeTurnID && activeTurnID !== turnResult.turn.id)
      throw new Error("Codex app-server returned a turn id different from turn/started")
    activeTurnID = turnResult.turn.id
    const observedSettings = await beforeTimeout<SubsystemCodex.ThreadSettings | { error: string }>(
      settingsAttestation,
      CODEX_SETTINGS_ATTESTATION_TIMEOUT_MS,
      { error: "Codex did not attest its resolved settings before the turn became operational." },
    )
    const attestationError =
      "error" in observedSettings
        ? observedSettings.error
        : SubsystemCodex.attestThreadSettings(observedSettings, requestedEffort, activeThreadID)
    if (attestationError) {
      const interruptWarning = await request(
        "turn/interrupt",
        { threadId: activeThreadID, turnId: activeTurnID },
        TURN_STEER_RPC_TIMEOUT_MS,
      ).then(
        () => undefined,
        (error) => `Could not interrupt the unattested Codex turn: ${errorDetail(error)}`,
      )
      await stopAppServer(proc)
      await exitObservation
      await settleServerRequests()
      const [raw, err, sanitizeWarning] = await Promise.all([
        stdout.catch((error) => {
          return { raw: "", truncated: false, error }
        }),
        stderr,
        sanitizationWarning(input),
      ])
      const failureReason = `Codex settings attestation failed: ${attestationError}`
      return {
        stdout: raw.raw,
        stderr: [
          proc.spawnError ?? err.text,
          !proc.spawnError ? truncationWarning("output", raw.truncated) : undefined,
          !proc.spawnError ? truncationWarning("error", err.truncated) : undefined,
          !proc.spawnError && raw.error ? `Codex output stream failed: ${errorDetail(raw.error)}` : undefined,
          !proc.spawnError && err.error ? `Codex error stream failed: ${errorDetail(err.error)}` : undefined,
          failureReason,
          interruptWarning,
          sanitizeWarning,
        ]
          .filter(Boolean)
          .join("\n"),
        exitCode: 1,
        timedOut: wasTimedOut(proc),
        termination: "provider_failed",
        failureReason,
      }
    }
    if (input.sessionID) {
      unregister = SubsystemCodexControl.register(input.sessionID, {
        steer: async (text) => {
          if (!activeThreadID || !activeTurnID) return false
          try {
            const result = await request(
              "turn/steer",
              {
                threadId: activeThreadID,
                expectedTurnId: activeTurnID,
                input: [{ type: "text", text }],
              },
              TURN_STEER_RPC_TIMEOUT_MS,
            )
            return isRecord(result) && result.turnId === activeTurnID
          } catch (error) {
            log.warn("Codex turn steering failed", { sessionID: input.sessionID, error })
            return false
          }
        },
      })
    }

    completedTurn = await Promise.race([turnCompleted, proc.exited.then(() => undefined)])
    unregister?.()
    unregister = undefined
    const logicalExitCode = completedTurn?.status === "completed" ? 0 : 1
    const failure = input.provider.classifyFailure(completedTurn)
    await stopAppServer(proc)
    await exitObservation
    await settleServerRequests()
    const [raw, err, sanitizeWarning] = await Promise.all([
      stdout.catch((error) => {
        return { raw: "", truncated: false, error }
      }),
      stderr,
      sanitizationWarning(input),
    ])
    return {
      stdout: raw.raw,
      stderr: [
        proc.spawnError ?? err.text,
        !proc.spawnError ? truncationWarning("output", raw.truncated) : undefined,
        !proc.spawnError ? truncationWarning("error", err.truncated) : undefined,
        !proc.spawnError && raw.error ? `Codex output stream failed: ${errorDetail(raw.error)}` : undefined,
        !proc.spawnError && err.error ? `Codex error stream failed: ${errorDetail(err.error)}` : undefined,
        sanitizeWarning,
      ]
        .filter(Boolean)
        .join("\n"),
      exitCode: logicalExitCode,
      timedOut: wasTimedOut(proc),
      termination: terminationOf(proc, logicalExitCode),
      ...(failure ? { failure } : {}),
    }
  } catch (error) {
    unregister?.()
    const cleanupWarning = proc
      ? await stopAppServer(proc).then(
          () => undefined,
          (cleanupError) => `Codex app-server cleanup failed: ${errorDetail(cleanupError)}`,
        )
      : undefined
    await exitObservation
    await settleServerRequests()
    return {
      stdout: "",
      stderr: withWarning(errorDetail(error), cleanupWarning),
      exitCode: proc?.spawnError ? 127 : 1,
      timedOut: proc ? wasTimedOut(proc) : false,
      termination: cleanupWarning
        ? "provider_failed"
        : proc
          ? terminationOf(proc, proc.spawnError ? 127 : 1)
          : "spawn_failed",
    }
  }
}

function isOperationalCodexEvent(event: Record<string, unknown>): boolean {
  if (event.method !== "item/started" || !isRecord(event.params) || !isRecord(event.params.item)) return false
  return !["userMessage", "reasoning", "agentMessage", "plan"].includes(String(event.params.item.type))
}

export async function run(input: RunInput): Promise<RunResult> {
  if (input.provider.name === "codex" && input.sessionID) return runCodexAppServer(input)
  try {
    const proc = spawnCli(input)
    const [stdout, stderr] = await Promise.all([drainText(proc.stdout), drainText(proc.stderr)])
    const exitCode = await proc.exited
    await proc.lifecycle
    const cleanupWarning = await proc.cleanup?.().then(
      () => undefined,
      (error) => `Expert process cleanup failed: ${errorDetail(error)}`,
    )
    const sanitizeWarning = await sanitizationWarning(input)
    // spawnError (async ENOENT etc.) is preferred over the empty stderr of a stream that never produced.
    return {
      stdout: stdout.text,
      stderr: [
        proc.spawnError ?? stderr.text,
        !proc.spawnError ? truncationWarning("output", stdout.truncated) : undefined,
        !proc.spawnError ? truncationWarning("error", stderr.truncated) : undefined,
        !proc.spawnError && stdout.error ? `Expert output stream failed: ${errorDetail(stdout.error)}` : undefined,
        !proc.spawnError && stderr.error ? `Expert error stream failed: ${errorDetail(stderr.error)}` : undefined,
        cleanupWarning,
        sanitizeWarning,
      ]
        .filter(Boolean)
        .join("\n"),
      exitCode: exitCode ?? 0,
      timedOut: wasTimedOut(proc),
      termination: cleanupWarning ? "provider_failed" : terminationOf(proc, exitCode ?? 0),
      failureReason: cleanupWarning,
    }
  } catch (error) {
    // A synchronous spawn failure (e.g. a bad cwd). Surface it as a failed run.
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 127,
      timedOut: false,
      termination: "spawn_failed",
    }
  }
}

// Streaming twin of run(): spawn the CLI (identical contract), deliver each parsed stream-json event
// to onEvent as it arrives, and still return the buffered RunResult so the caller unwraps the final
// reply exactly as for a json run. onEvent runs synchronously as each event is decoded.
export async function runStreaming(input: RunInput, onEvent: (event: unknown) => void): Promise<RunResult> {
  if (input.provider.name === "codex" && input.sessionID) return runCodexAppServer(input, onEvent)
  try {
    const proc = spawnCli(input)
    const [stdout, stderr] = await Promise.all([consumeNdjson(proc.stdout, onEvent), drainText(proc.stderr)])
    const exitCode = await proc.exited
    await proc.lifecycle
    const cleanupWarning = await proc.cleanup?.().then(
      () => undefined,
      (error) => `Expert process cleanup failed: ${errorDetail(error)}`,
    )
    const sanitizeWarning = await sanitizationWarning(input)
    return {
      stdout: stdout.raw,
      stderr: [
        proc.spawnError ?? stderr.text,
        !proc.spawnError ? truncationWarning("output", stdout.truncated) : undefined,
        !proc.spawnError ? truncationWarning("error", stderr.truncated) : undefined,
        !proc.spawnError && stdout.error ? `Expert event stream failed: ${errorDetail(stdout.error)}` : undefined,
        !proc.spawnError && stderr.error ? `Expert error stream failed: ${errorDetail(stderr.error)}` : undefined,
        cleanupWarning,
        sanitizeWarning,
      ]
        .filter(Boolean)
        .join("\n"),
      exitCode: exitCode ?? 0,
      timedOut: wasTimedOut(proc),
      termination: cleanupWarning ? "provider_failed" : terminationOf(proc, exitCode ?? 0),
      failureReason: cleanupWarning,
    }
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 127,
      timedOut: false,
      termination: "spawn_failed",
    }
  }
}

// ── Streaming Decode Preserves Events And A Bounded Final Tail ─────
// Provider chunks can split an NDJSON value at any byte boundary, so complete
// lines are assembled before parsing and valid events remain ordered. One
// oversized line is discarded until its newline without blocking later events.
// Raw retention keeps only the final byte window where providers place their
// result event, preventing verbose activity from growing process memory forever.
// ─────────────────────────────────────────────────────────────
export async function consumeNdjson(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: unknown) => void,
  options: { maxOutputBytes?: number; maxLineBytes?: number } = {},
): Promise<{ raw: string; truncated: boolean; error?: unknown }> {
  const maxOutputBytes = options.maxOutputBytes ?? PROVIDER_OUTPUT_LIMIT_BYTES
  const maxLineBytes = options.maxLineBytes ?? PROVIDER_NDJSON_LINE_LIMIT_BYTES
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0)
    throw new Error("maxOutputBytes must be a positive safe integer")
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0)
    throw new Error("maxLineBytes must be a positive safe integer")

  const rawOutput = new BoundedByteTail(maxOutputBytes)
  const reader = stream.getReader()
  let lineChunks: Buffer[] = []
  let lineBytes = 0
  let discardingLine = false
  let oversizedLine = false
  let streamError: unknown
  const flush = () => {
    const line = Buffer.concat(lineChunks, lineBytes)
    const content = line.at(-1) === 0x0d ? line.subarray(0, -1) : line
    const candidate = content.toString("utf8").trim()
    if (!candidate) return
    let event: unknown
    try {
      event = JSON.parse(candidate)
    } catch (error) {
      if (error instanceof SyntaxError) return
      throw error
    }
    try {
      onEvent(event)
    } catch (error) {
      // Activity presentation is observational; one consumer failure must not abort the provider turn,
      // but it remains visible because otherwise the UI could silently stop reflecting live work.
      log.warn("streaming activity observer failed", { error })
    }
  }
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      rawOutput.append(next.value)
      const chunk = Buffer.from(next.value)
      let offset = 0
      while (offset < chunk.byteLength) {
        const newline = chunk.indexOf(0x0a, offset)
        const end = newline === -1 ? chunk.byteLength : newline
        const segment = chunk.subarray(offset, end)
        if (!discardingLine && lineBytes + segment.byteLength <= maxLineBytes) {
          if (segment.byteLength > 0) lineChunks.push(Buffer.from(segment))
          lineBytes += segment.byteLength
        } else if (!discardingLine) {
          lineChunks = []
          lineBytes = 0
          discardingLine = true
          oversizedLine = true
        }

        if (newline === -1) break
        if (!discardingLine) flush()
        lineChunks = []
        lineBytes = 0
        discardingLine = false
        offset = newline + 1
      }
    }
  } catch (error) {
    // A killed provider can break the reader after valid events. Returning the accumulated stream is
    // the explicit partial-transcript result; the process termination remains visible on RunResult.
    streamError = error
  } finally {
    reader.releaseLock()
  }
  if (!discardingLine && lineBytes > 0) flush()
  const result = { raw: rawOutput.text(), truncated: rawOutput.truncated || oversizedLine }
  return streamError === undefined ? result : { ...result, error: streamError }
}

export * as SubsystemCli from "./cli"
