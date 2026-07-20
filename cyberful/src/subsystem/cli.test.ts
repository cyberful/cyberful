// ── Subsystem CLI Lifecycle Tests ────────────────────────────────────────────
// Exercises streaming transport, Codex app-server steering, subprocess budgets,
// and process-group cleanup through real local child processes.
// → cyberful/src/subsystem/fixtures/codex-app-server.ts — emulates the app-server protocol.
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { SubsystemCli } from "./cli"
import { SubsystemProvider } from "./provider"
import { SubsystemCodex } from "./codex"
import { SubsystemControl } from "./control"
import { SubsystemApprovalState } from "./approval-state"
import { chmod, mkdtemp, readFile, rm, stat } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import * as Builtin from "@/builtin"

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null) throw new Error(message)
  return value
}

function testProvider(overrides: Partial<SubsystemProvider.Provider> = {}): SubsystemProvider.Provider {
  return {
    name: "codex",
    buildArgs: () => ({ args: [], extraEnv: {} }),
    buildAppServerArgs: () => ({ args: [], extraEnv: {} }),
    extractResultText: () => "",
    streamActivities: () => [],
    ...overrides,
  }
}

test("private MCP environment is materialized outside argv with owner-only permissions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cyberful-private-mcp-test-"))
  try {
    const spec = SubsystemCli.materializePrivateMcpEnvironment(
      {
        cwd: "/work",
        permission: { kind: "readonly" },
        mcpServer: {
          name: "gateway",
          command: "cyberful",
          args: ["gateway"],
          env: {},
          privateEnv: { CYBER_ZAP_API_KEY: "private-value", CYBERFUL_SUBSYSTEM_SESSION: "ses_1" },
        },
      },
      directory,
    )
    const file = spec.mcpServer?.env.CYBERFUL_SUBSYSTEM_ENV_PATH
    expect(file).toBe(path.join(directory, "gateway-environment.json"))
    expect(spec.mcpServer?.privateEnv).toBeUndefined()
    const environmentFile = requireValue(file, "materialized MCP environment did not expose its file path")
    expect(JSON.parse(await readFile(environmentFile, "utf8"))).toEqual({
      CYBER_ZAP_API_KEY: "private-value",
      CYBERFUL_SUBSYSTEM_SESSION: "ses_1",
    })
    expect((await stat(environmentFile)).mode & 0o777).toBe(0o600)
    expect(SubsystemProvider.codex.buildAppServerArgs(spec).args.join(" ")).not.toContain("private-value")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("a completed one-shot run removes its owner-private MCP environment", async () => {
  let privateDirectory: string | undefined
  const provider = testProvider({
    buildArgs: (spec: SubsystemProvider.SubsystemRunSpec) => {
      const environmentFile = spec.mcpServer?.env.CYBERFUL_SUBSYSTEM_ENV_PATH
      if (environmentFile) privateDirectory = path.dirname(environmentFile)
      return { args: ["-e", ""], extraEnv: {} }
    },
  })

  const result = await SubsystemCli.run({
    provider,
    spec: {
      cwd: process.cwd(),
      permission: { kind: "readonly" },
      mcpServer: {
        name: "gateway",
        command: "gateway",
        args: [],
        env: {},
        privateEnv: { CYBERFUL_SUBSYSTEM_SESSION: "ses_cleanup" },
      },
    },
    command: process.execPath,
    prompt: "",
    timeoutMs: 5_000,
  })

  expect(result.exitCode).toBe(0)
  expect(privateDirectory).toBeDefined()
  const cleanedDirectory = requireValue(privateDirectory, "one-shot run did not materialize a private MCP directory")
  await expect(stat(cleanedDirectory)).rejects.toMatchObject({ code: "ENOENT" })
})

// ── Stream Tests Use Real Byte Boundaries Without A Provider ──────────
// The decoder must reassemble NDJSON split across arbitrary chunks, preserve
// complete events before a stream failure, and return raw text for final-result
// extraction. In-memory byte streams exercise that production parser directly,
// making the boundary deterministic and quiet without replacing its behavior
// with a duplicated parser or launching an external CLI.
// ──────────────────────────────────────────────────────────────
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

describe("consumeNdjson", () => {
  test("parses whole lines and reassembles one split across chunk boundaries", async () => {
    const events: unknown[] = []
    // The middle event's JSON is split mid-object across two chunks; the final line has no newline.
    const { raw } = await SubsystemCli.consumeNdjson(
      streamOf([`{"type":"system"}\n{"type":"assis`, `tant","n":1}\n`, `{"type":"result","result":"done"}`]),
      (e) => events.push(e),
    )
    expect(events).toEqual([{ type: "system" }, { type: "assistant", n: 1 }, { type: "result", result: "done" }])
    // The raw text is returned intact so extractResultText can unwrap the final reply from it.
    expect(raw).toContain(`"result":"done"`)
  })

  test("skips a malformed line instead of failing the whole stream", async () => {
    const events: unknown[] = []
    await SubsystemCli.consumeNdjson(streamOf([`{"type":"a"}\n`, `this is not json\n`, `{"type":"b"}\n`]), (e) =>
      events.push(e),
    )
    expect(events).toEqual([{ type: "a" }, { type: "b" }])
  })

  test("ignores blank lines and a trailing newline", async () => {
    const events: unknown[] = []
    await SubsystemCli.consumeNdjson(streamOf([`\n{"type":"a"}\n\n`]), (e) => events.push(e))
    expect(events).toEqual([{ type: "a" }])
  })

  test("returns complete events received before a stream error", async () => {
    const encoder = new TextEncoder()
    let pulled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pulled) {
          pulled = true
          controller.enqueue(encoder.encode(`{"type":"assistant","text":"kept"}\n`))
          return
        }
        controller.error(new Error("broken stream"))
      },
    })
    const events: unknown[] = []
    const { raw, error } = await SubsystemCli.consumeNdjson(stream, (event) => events.push(event))
    expect(events).toEqual([{ type: "assistant", text: "kept" }])
    expect(raw).toContain(`"text":"kept"`)
    expect(error).toBeInstanceOf(Error)
  })

  test("retains only the final raw window while delivering every complete event", async () => {
    const events: unknown[] = []
    const first = `${JSON.stringify({ type: "assistant", text: "a".repeat(48) })}\n`
    const result = `${JSON.stringify({ type: "result", result: "done" })}\n`
    const output = await SubsystemCli.consumeNdjson(streamOf([first, result]), (event) => events.push(event), {
      maxOutputBytes: 64,
      maxLineBytes: 128,
    })

    expect(events).toEqual([
      { type: "assistant", text: "a".repeat(48) },
      { type: "result", result: "done" },
    ])
    expect(Buffer.byteLength(output.raw)).toBeLessThanOrEqual(64)
    expect(output.raw).toContain(`"result":"done"`)
    expect(output.truncated).toBe(true)
  })

  test("discards one oversized frame and resumes at the next event", async () => {
    const events: unknown[] = []
    const oversized = `${JSON.stringify({ type: "assistant", text: "x".repeat(200) })}\n`
    const result = `${JSON.stringify({ type: "result", result: "kept" })}\n`
    const output = await SubsystemCli.consumeNdjson(streamOf([oversized, result]), (event) => events.push(event), {
      maxOutputBytes: 128,
      maxLineBytes: 64,
    })

    expect(events).toEqual([{ type: "result", result: "kept" }])
    expect(output.truncated).toBe(true)
  })
})

// A provider stub whose buildArgs turns the spawn into a plain `sleep <seconds>`, so these tests
// exercise the real subprocess tracking without a live Codex process — buildArgs is the only Provider
// method spawnCli calls before spawning.
function sleepProvider(seconds: number): SubsystemProvider.Provider {
  return testProvider({
    buildArgs: () => ({ args: [String(seconds)], extraEnv: {} }),
  })
}

function sleepInput(seconds: number): SubsystemCli.RunInput {
  return {
    provider: sleepProvider(seconds),
    spec: { cwd: process.cwd(), permission: { kind: "readonly" } },
    command: "sleep",
    prompt: "",
    timeoutMs: 60_000,
  }
}

async function waitForLiveCount(expected: number): Promise<void> {
  if (SubsystemCli.liveCount() === expected) return
  await new Promise<void>((resolve) => {
    SubsystemCli.onLiveChange((pids) => {
      if (pids.length !== expected) return
      SubsystemCli.onLiveChange(() => {})
      resolve()
    })
  })
}

// Regression for orphaned Expert subprocesses surviving a TUI close: the Codex spawn is a raw
// Bun.spawn outside any Effect scope, so nothing reaps it on shutdown unless it is tracked and
// killAll() reaches it. These pin the tracking + kill the worker shutdown funnel depends on.
describe("Expert subprocess lifecycle", () => {
  // killAll() latches shutting-down permanently by design; clear it between cases so this in-process
  // suite, which calls killAll() several times, does not carry the latch from one test into the next.
  beforeEach(() => SubsystemCli.resetForTests())
  afterEach(async () => {
    try {
      await SubsystemCli.killAll()
    } finally {
      SubsystemCli.resetForTests()
      SubsystemCli.onLiveChange(() => {})
    }
  })

  test("killAll terminates an in-flight subprocess and clears the registry", async () => {
    const running = SubsystemCli.run(sleepInput(30)) // in flight — do NOT await yet
    await waitForLiveCount(1)
    expect(SubsystemCli.liveCount()).toBe(1)

    await SubsystemCli.killAll()

    const result = await running
    // A killed sleep exits via signal (SIGTERM/SIGKILL), never a clean exit 0.
    expect(result.timedOut).toBe(false)
    expect(result.termination).toBe("shutdown")
    expect(result.exitCode).not.toBe(0)
    expect(SubsystemCli.liveCount()).toBe(0)
  })

  test("shutdown removes the private MCP environment of an in-flight process", async () => {
    let privateDirectory: string | undefined
    const provider = testProvider({
      buildArgs: (spec: SubsystemProvider.SubsystemRunSpec) => {
        const environmentFile = spec.mcpServer?.env.CYBERFUL_SUBSYSTEM_ENV_PATH
        if (environmentFile) privateDirectory = path.dirname(environmentFile)
        return { args: ["30"], extraEnv: {} }
      },
    })
    const running = SubsystemCli.run({
      ...sleepInput(30),
      provider,
      spec: {
        cwd: process.cwd(),
        permission: { kind: "readonly" },
        mcpServer: {
          name: "gateway",
          command: "gateway",
          args: [],
          env: {},
          privateEnv: { CYBERFUL_SUBSYSTEM_SESSION: "ses_shutdown_cleanup" },
        },
      },
    })
    await waitForLiveCount(1)
    expect(privateDirectory).toBeDefined()

    await SubsystemCli.killAll()

    const cleanedDirectory = requireValue(
      privateDirectory,
      "long-running command did not materialize a private MCP directory",
    )
    await expect(stat(cleanedDirectory)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await running).termination).toBe("shutdown")
  })

  test("the main-process PID mirror is cleared after SIGKILL fallback", async () => {
    const notifications: number[][] = []
    const processRegistered = Promise.withResolvers<void>()
    SubsystemCli.onLiveChange((pids) => {
      notifications.push(pids)
      if (pids.length === 1) processRegistered.resolve()
    })
    const provider = testProvider({
      buildArgs: () => ({ args: ["-c", "trap '' TERM; sleep 30"], extraEnv: {} }),
    })
    const running = SubsystemCli.run({ ...sleepInput(30), provider, command: "/bin/sh" })
    await processRegistered.promise

    await SubsystemCli.killAll()
    await running

    expect(notifications.some((pids) => pids.length === 1)).toBe(true)
    expect(notifications.at(-1)).toEqual([])
  })

  test("a subprocess that exits on its own leaves the registry empty", async () => {
    const result = await SubsystemCli.run(sleepInput(0)) // `sleep 0` returns immediately
    expect(result.exitCode).toBe(0)
    expect(result.termination).toBe("completed")
    expect(SubsystemCli.liveCount()).toBe(0)
  })

  test("a caller abort kills only its own process group without reporting budget exhaustion", async () => {
    const controller = new AbortController()
    const running = SubsystemCli.run({ ...sleepInput(30), abort: controller.signal })
    await waitForLiveCount(1)
    controller.abort()
    const result = await running
    expect(result.exitCode).not.toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.termination).toBe("provider_failed")
    expect(SubsystemCli.liveCount()).toBe(0)
  })

  test("a caller abort force-kills a process group that ignores SIGTERM", async () => {
    const provider = testProvider({
      buildArgs: () => ({ args: ["-c", "trap '' TERM; sleep 30"], extraEnv: {} }),
    })
    const controller = new AbortController()
    const running = SubsystemCli.run({ ...sleepInput(30), provider, command: "/bin/sh", abort: controller.signal })
    await waitForLiveCount(1)
    const started = Date.now()

    controller.abort()
    const result = await running

    expect(result.exitCode).not.toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.termination).toBe("provider_failed")
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(SubsystemCli.liveCount()).toBe(0)
  })

  test("a caller budget abort is classified as budget exhaustion", async () => {
    const controller = new AbortController()
    const running = SubsystemCli.run({ ...sleepInput(30), abort: controller.signal })
    await waitForLiveCount(1)
    controller.abort("budget_exhausted")
    const result = await running
    expect(result.timedOut).toBe(true)
    expect(result.termination).toBe("budget_exhausted")
  })

  // An absent CLI must still surface as a failed run WITH its reason. With the Node spawn the ENOENT
  // arrives async on the child's 'error' (not on stderr), so spawnError has to carry it into the result.
  test("a missing CLI is a failed run (exit 127) that keeps its error reason", async () => {
    const provider = testProvider()
    const result = await SubsystemCli.run({
      provider,
      spec: { cwd: process.cwd(), permission: { kind: "readonly" } },
      command: "cyberful-no-such-expert-binary",
      prompt: "",
      timeoutMs: 60_000,
    })
    expect(result.exitCode).toBe(127)
    expect(result.termination).toBe("spawn_failed")
    expect(result.stderr.length).toBeGreaterThan(0)
    expect(SubsystemCli.liveCount()).toBe(0)
  })

  test("killAll is a no-op when nothing is in flight", async () => {
    expect(SubsystemCli.liveCount()).toBe(0)
    await SubsystemCli.killAll()
    expect(SubsystemCli.liveCount()).toBe(0)
  })

  // The orphan we actually saw: shutdown had begun, then a producer fiber spawned the next phase before
  // it was interrupted. That late Codex process must be reaped on arrival, never registered as a survivor —
  // otherwise it outlives the closing host (killAll's snapshot already passed) and keeps acting.
  test("a subprocess spawned after killAll has begun is reaped, never registered", async () => {
    await SubsystemCli.killAll() // nothing live yet: this just latches shutting-down
    const running = SubsystemCli.run(sleepInput(30)) // a producer racing the teardown
    const result = await running
    expect(SubsystemCli.liveCount()).toBe(0) // it never joined the survivable set
    // Killed on arrival (SIGTERM/SIGKILL), never left running — same signature as a killAll'd proc.
    expect(result.exitCode).not.toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.termination).toBe("shutdown")
  })

  test("the real Codex adapter is group-killed at its short wall-clock budget", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cyberful-codex-budget-"))
    const command = path.join(dir, "codex-fixture")
    try {
      // The real Codex adapter still builds its production argv; this tiny executable deliberately ignores
      // those arguments and sleeps, isolating the host timer/process-group contract from a network/model call.
      await Bun.write(command, "#!/bin/sh\nsleep 30\n")
      await chmod(command, 0o755)
      const startedAt = Date.now()
      const result = await SubsystemCli.run({
        provider: SubsystemProvider.codex,
        spec: { cwd: process.cwd(), permission: { kind: "readonly" } },
        command,
        prompt: "",
        timeoutMs: 75,
      })
      expect(result.termination).toBe("budget_exhausted")
      expect(result.timedOut).toBe(true)
      expect(result.exitCode).not.toBe(0)
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      expect(SubsystemCli.liveCount()).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a pending approval pauses the process budget until its decision arrives", async () => {
    const approvalState = SubsystemApprovalState.create()
    const decision = Promise.withResolvers<void>()
    const startedAt = Date.now()
    const running = SubsystemCli.run({
      ...sleepInput(30),
      timeoutMs: 250,
      approvalState,
    })
    await waitForLiveCount(1)
    const waiting = approvalState.wait(() => decision.promise)

    await Bun.sleep(350)
    expect(SubsystemCli.liveCount()).toBe(1)
    decision.resolve()
    await waiting

    const result = await running
    expect(result.termination).toBe("budget_exhausted")
    expect(result.timedOut).toBe(true)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500)
  })

  test("the Codex app-server turn accepts a live steer before completing", async () => {
    const provider: SubsystemProvider.Provider = {
      ...SubsystemProvider.codex,
      buildAppServerArgs: () => ({
        args: [path.join(import.meta.dir, "fixtures/codex-app-server.ts")],
        extraEnv: {
          CYBERFUL_FIXTURE_REQUIRE_SKILLS: "1",
          CYBERFUL_FIXTURE_EXPECT_EFFORT: SubsystemCodex.effort(),
        },
      }),
    }
    const running = SubsystemCli.runStreaming(
      {
        provider,
        spec: {
          cwd: process.cwd(),
          permission: { kind: "autonomous" },
          skillRoots: [path.join(Builtin.DIR, "skills")],
        },
        command: process.execPath,
        prompt: "initial phase objective",
        timeoutMs: 5_000,
        sessionID: "ses_app_server_test",
      },
      () => {},
    )

    const registration = await Promise.race([
      (async () => {
        const deadline = Date.now() + 2_000
        while (SubsystemControl.activeCount("ses_app_server_test") === 0 && Date.now() < deadline) {
          await Bun.sleep(10)
        }
        return SubsystemControl.activeCount("ses_app_server_test")
      })(),
      running.then((result) => {
        throw new Error(`Codex app-server exited before steering registered: ${result.stderr || result.termination}`)
      }),
    ])
    expect(registration).toBe(1)
    expect(
      await SubsystemControl.steer({
        sessionID: "ses_app_server_test",
        text: "prioritize the admin route",
      }),
    ).toEqual({ accepted: true, recipients: 1 })

    const result = await running
    expect(result.termination).toBe("completed")
    expect(result.exitCode).toBe(0)
    expect(SubsystemProvider.codex.extractResultText(result.stdout)).toBe("steered: prioritize the admin route")
    expect(SubsystemControl.activeCount("ses_app_server_test")).toBe(0)
  })

  test("fails closed when app-server attests settings different from the requested effort", async () => {
    const provider: SubsystemProvider.Provider = {
      ...SubsystemProvider.codex,
      buildAppServerArgs: () => ({
        args: [path.join(import.meta.dir, "fixtures/codex-app-server.ts")],
        extraEnv: { CYBERFUL_FIXTURE_RESOLVED_EFFORT: "definitely-not-requested" },
      }),
    }
    const result = await SubsystemCli.runStreaming(
      {
        provider,
        spec: { cwd: process.cwd(), permission: { kind: "readonly" } },
        command: process.execPath,
        prompt: "do not run",
        timeoutMs: 5_000,
        sessionID: "ses_bad_attestation",
      },
      () => {},
    )
    expect(result.termination).toBe("provider_failed")
    expect(result.failureReason).toContain("Codex settings attestation failed")
    expect(result.failureReason).toContain("expected")
    expect(result.stdout).toContain("thread/settings/updated")
  })

  test("fails closed if operational activity starts before settings are attested", async () => {
    const provider: SubsystemProvider.Provider = {
      ...SubsystemProvider.codex,
      buildAppServerArgs: () => ({
        args: [path.join(import.meta.dir, "fixtures/codex-app-server.ts")],
        extraEnv: { CYBERFUL_FIXTURE_OPERATION_BEFORE_SETTINGS: "1" },
      }),
    }
    const result = await SubsystemCli.runStreaming(
      {
        provider,
        spec: { cwd: process.cwd(), permission: { kind: "readonly" } },
        command: process.execPath,
        prompt: "do not run",
        timeoutMs: 5_000,
        sessionID: "ses_missing_attestation",
      },
      () => {},
    )
    expect(result.termination).toBe("provider_failed")
    expect(result.failureReason).toContain("before attesting")
    expect(result.stdout).toContain("tool-before-settings")
  })
})
