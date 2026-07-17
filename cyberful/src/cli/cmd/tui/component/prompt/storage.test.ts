// ── Prompt State Storage Tests ───────────────────────────────────
// Protects the routine startup path that restores recent prompt state while
//   ignoring malformed records and an incomplete line at the bounded-read edge.
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendJsonLine, createSerializedWrites, readJsonLines, writeJsonLines } from "./storage"

const directories: string[] = []
const isStoredPrompt = (value: unknown): value is { input: string } =>
  typeof value === "object" && value !== null && "input" in value && typeof value.input === "string"

async function stateFile() {
  const directory = await mkdtemp(join(tmpdir(), "cyberful-prompt-storage-test-"))
  directories.push(directory)
  return join(directory, "history.jsonl")
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("prompt state storage", () => {
  test("round-trips recent validated records in user-visible order", async () => {
    const file = await stateFile()
    await writeJsonLines(file, [{ input: "first" }, { ignored: true }, { input: "second" }])
    await appendJsonLine(file, { input: "third" })

    expect(await readJsonLines(file, 2, isStoredPrompt)).toEqual([{ input: "second" }, { input: "third" }])
  })

  test("drops a truncated bounded-read prefix and malformed records", async () => {
    const file = await stateFile()
    await Bun.write(file, `${"x".repeat(2 * 1024 * 1024)}\nnot-json\n{"input":"restored"}\n`)

    expect(await readJsonLines(file, 10, isStoredPrompt)).toEqual([{ input: "restored" }])
  })

  test("preserves user write order while an earlier write is still pending", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const writes: string[] = []
    const errors: unknown[] = []
    const queue = createSerializedWrites((error) => errors.push(error))

    queue.enqueue(async () => {
      started.resolve()
      await release.promise
      writes.push("startup-compaction")
    })
    queue.enqueue(async () => {
      writes.push("append")
    })
    queue.enqueue(async () => {
      writes.push("bounded-rewrite")
    })

    await started.promise
    release.resolve()
    await queue.drain()

    expect(writes).toEqual(["startup-compaction", "append", "bounded-rewrite"])
    expect(errors).toEqual([])
  })

  test("observes one failed write and continues with later user state", async () => {
    const writes: string[] = []
    const errors: unknown[] = []
    const queue = createSerializedWrites((error) => errors.push(error))

    queue.enqueue(async () => {
      throw new Error("disk unavailable")
    })
    queue.enqueue(async () => {
      writes.push("next prompt")
    })
    await queue.drain()

    expect(errors).toHaveLength(1)
    expect(writes).toEqual(["next prompt"])
  })
})
