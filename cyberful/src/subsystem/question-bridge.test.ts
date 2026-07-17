// ── Gateway Question Bridge Tests ────────────────────────────────
// Verifies round-trips, input limits, serialized volume, cancellation, and
// cleanup between the standalone phase process and the in-process human prompt.
// → cyberful/src/subsystem/question-bridge.ts — owns the tested private IPC bridge.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SubsystemQuestionBridge } from "./question-bridge"

async function waitForResponse(filePath: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const response: unknown = JSON.parse(await readFile(filePath, "utf8"))
      return response
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error
      await Bun.sleep(20)
    }
  }
  throw new Error(`timed out waiting for question response ${filePath}`)
}

async function pathExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

async function waitForMissing(filePath: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!(await pathExists(filePath))) return
    await Bun.sleep(5)
  }
  throw new Error(`timed out waiting for question bridge cleanup ${filePath}`)
}

async function writeRequest(directory: string, id: string) {
  const temporary = path.join(directory, `${id}.tmp`)
  const request = path.join(directory, `${id}.request.json`)
  await writeFile(
    temporary,
    JSON.stringify({
      id,
      questions: [
        {
          header: "Scope",
          question: `Continue request ${id}?`,
          options: [{ label: "Continue", description: "Proceed with the current scope." }],
        },
      ],
    }),
  )
  await rename(temporary, request)
}

describe("Expert question bridge", () => {
  test("round-trips a gateway question through the host callback", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "expert-question-test-"))
    const directory = path.join(parent, "bridge")
    const bridge = await SubsystemQuestionBridge.start(directory, async (questions) =>
      questions.map((question) => [question.options[0]?.label ?? "custom"]),
    )
    try {
      const temporary = path.join(directory, "q1.tmp")
      const request = path.join(directory, "q1.request.json")
      const response = path.join(directory, "q1.response.json")
      await writeFile(
        temporary,
        JSON.stringify({
          id: "q1",
          questions: [
            {
              header: "Scope",
              question: "Continue with the authenticated test?",
              options: [{ label: "Continue", description: "Proceed with the current scope." }],
            },
          ],
        }),
      )
      await rename(temporary, request)

      expect(await waitForResponse(response)).toEqual({ id: "q1", answers: [["Continue"]] })
    } finally {
      await bridge.stop()
      await rm(parent, { recursive: true, force: true })
    }
  })

  test("rejects malformed gateway questions before invoking the human callback", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "expert-question-invalid-test-"))
    const directory = path.join(parent, "bridge")
    let invoked = false
    const bridge = await SubsystemQuestionBridge.start(directory, async () => {
      invoked = true
      return []
    })
    try {
      await writeFile(
        path.join(directory, "q2.request.json"),
        JSON.stringify({ id: "q2", questions: [{ header: 42, question: "Continue?", options: [] }] }),
      )
      expect(await waitForResponse(path.join(directory, "q2.response.json"))).toEqual({
        error: "question bridge request has an invalid question",
      })
      expect(invoked).toBe(false)
    } finally {
      await bridge.stop()
      await rm(parent, { recursive: true, force: true })
    }
  })

  test("serializes more than one discovery batch without concurrent human prompts", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "expert-question-volume-test-"))
    const directory = path.join(parent, "bridge")
    let active = 0
    let maximumActive = 0
    let calls = 0
    const bridge = await SubsystemQuestionBridge.start(directory, async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      calls += 1
      try {
        await Promise.resolve()
        return [["Continue"]]
      } finally {
        active -= 1
      }
    })
    const ids = Array.from({ length: 80 }, (_, index) => `volume-${index}`)
    try {
      for (const id of ids) await writeRequest(directory, id)
      for (const id of ids) {
        expect(await waitForResponse(path.join(directory, `${id}.response.json`))).toEqual({
          id,
          answers: [["Continue"]],
        })
      }
      expect(calls).toBe(80)
      expect(maximumActive).toBe(1)
    } finally {
      await bridge.stop()
      await rm(parent, { recursive: true, force: true })
    }
  })

  test("aborts a timed-out human prompt and returns a bounded error response", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "expert-question-timeout-test-"))
    const directory = path.join(parent, "bridge")
    let aborted = false
    const bridge = await SubsystemQuestionBridge.start(
      directory,
      async (_questions, signal) =>
        await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            aborted = true
            reject(signal.reason)
          }
          if (signal.aborted) abort()
          else signal.addEventListener("abort", abort, { once: true })
        }),
      { requestTimeoutMs: 25, pollIntervalMs: 5 },
    )
    try {
      await writeRequest(directory, "timeout")
      expect(await waitForResponse(path.join(directory, "timeout.response.json"))).toEqual({
        error: "question bridge request timed out after 25ms",
      })
      expect(aborted).toBe(true)
    } finally {
      await bridge.stop()
      await rm(parent, { recursive: true, force: true })
    }
  })

  test("stop cancels the active prompt and always removes the private directory", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "expert-question-cancel-test-"))
    const directory = path.join(parent, "bridge")
    const invoked = Promise.withResolvers<void>()
    let aborted = false
    const bridge = await SubsystemQuestionBridge.start(
      directory,
      async (_questions, signal) =>
        await new Promise<never>((_resolve, reject) => {
          invoked.resolve()
          const abort = () => {
            aborted = true
            reject(signal.reason)
          }
          if (signal.aborted) abort()
          else signal.addEventListener("abort", abort, { once: true })
        }),
      { stopTimeoutMs: 500, pollIntervalMs: 5 },
    )
    try {
      await writeRequest(directory, "cancel")
      await invoked.promise
      await bridge.stop()
      expect(aborted).toBe(true)
      expect(await pathExists(directory)).toBe(false)
    } finally {
      await bridge.stop()
      await rm(parent, { recursive: true, force: true })
    }
  })

  test("rejects an oversized request and removes its claimed file", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "expert-question-size-test-"))
    const directory = path.join(parent, "bridge")
    let invoked = false
    const bridge = await SubsystemQuestionBridge.start(directory, async () => {
      invoked = true
      return [["Continue"]]
    })
    try {
      await writeFile(
        path.join(directory, "oversized.request.json"),
        JSON.stringify({
          id: "oversized",
          questions: [
            {
              header: "Scope",
              question: "Continue?",
              options: [{ label: "Continue", description: "Proceed." }],
            },
          ],
          padding: "x".repeat(70 * 1024),
        }),
      )
      expect(await waitForResponse(path.join(directory, "oversized.response.json"))).toEqual({
        error: "question bridge request exceeds 64 KiB",
      })
      await waitForMissing(path.join(directory, "oversized.processing.json"))
      expect(invoked).toBe(false)
    } finally {
      await bridge.stop()
      await rm(parent, { recursive: true, force: true })
    }
  })
})
