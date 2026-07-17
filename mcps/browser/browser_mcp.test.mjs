// ── Browser MCP Boundary Contract ──────────────────────────────────
// Exercises malformed tool calls, bounded stdio framing, artifact confinement,
// and response-size proofs through the same entrypoints used by MCP clients.
// A rejected request must not launch Chromium or read an unbounded payload.
// → mcps/browser/browser_mcp.mjs — validates and dispatches browser tool calls.
// ────────────────────────────────────────────────────────────────────

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { afterAll, describe, expect, test } from "bun:test"

const artifactsDir = await mkdtemp(path.join(os.tmpdir(), "cyberful-browser-mcp-"))
const outsideDir = await mkdtemp(path.join(os.tmpdir(), "cyberful-browser-outside-"))
const previousArtifactsDir = process.env.CYBER_BROWSER_ARTIFACTS_DIR
process.env.CYBER_BROWSER_ARTIFACTS_DIR = artifactsDir
const { boundedJsonLines, envBool, handleToolCall, readBoundedResponseBody } = await import(
  `./browser_mcp.mjs?boundary-test=${Date.now()}`
)
if (previousArtifactsDir === undefined) delete process.env.CYBER_BROWSER_ARTIFACTS_DIR
else process.env.CYBER_BROWSER_ARTIFACTS_DIR = previousArtifactsDir

afterAll(async () => {
  await Promise.all([
    rm(artifactsDir, { force: true, recursive: true }),
    rm(outsideDir, { force: true, recursive: true }),
  ])
})

describe("browser MCP input boundary", () => {
  test("rejects malformed schema values before a browser action starts", async () => {
    const wrongType = await handleToolCall({
      name: "browser_wait",
      arguments: { milliseconds: "10" },
    })
    const unknownField = await handleToolCall({
      name: "browser_status",
      arguments: { unexpected: true },
    })

    expect(wrongType.isError).toBe(true)
    expect(wrongType.content[0].text).toContain("arguments.milliseconds: expected an integer")
    expect(unknownField.isError).toBe(true)
    expect(unknownField.content[0].text).toContain("unknown property unexpected")
  })

  test("accepts explicit environment booleans and rejects ambiguous values", () => {
    const name = "CYBERFUL_BROWSER_BOOLEAN_TEST"
    const previous = process.env[name]
    try {
      process.env[name] = " yes "
      expect(envBool(name, false)).toBe(true)
      process.env[name] = "sometimes"
      expect(() => envBool(name, false)).toThrow("must be one of")
    } finally {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    }
  })

  test("drops an oversized stdio frame and resumes at the next request", async () => {
    const input = Readable.from([Buffer.from("1234"), Buffer.from("56789\n{}\n")])
    const records = []
    for await (const record of boundedJsonLines(input, 8)) records.push(record)

    expect(records).toEqual([{ error: "input line exceeds 8 bytes" }, { line: "{}" }])
  })
})

describe("browser MCP retained data", () => {
  test("returns only the requested artifact prefix", async () => {
    await writeFile(path.join(artifactsDir, "evidence.txt"), "daily evidence")

    const result = await handleToolCall({
      name: "browser_artifact_read",
      arguments: { path: "evidence.txt", max_bytes: 5 },
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content[0].text).truncated).toBe(true)
    expect(result.content[1].text).toBe("daily\n[truncated]\n")
  })

  test("refuses an artifact symlink that resolves outside the artifact root", async () => {
    const outside = path.join(outsideDir, "private.txt")
    await writeFile(outside, "must not escape")
    await symlink(outside, path.join(artifactsDir, "escape.txt"))

    const result = await handleToolCall({
      name: "browser_artifact_read",
      arguments: { path: "escape.txt", max_bytes: 32 },
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("artifact reads are restricted")
    expect(result.content[0].text).not.toContain("must not escape")
  })

  test("rejects a declared oversized response before requesting its body", async () => {
    let bodyRead = false
    const response = {
      body: async () => {
        bodyRead = true
        return Buffer.alloc(9)
      },
      headers: () => ({ "content-length": "9" }),
      request: () => ({ method: () => "GET" }),
      status: () => 200,
    }

    await expect(readBoundedResponseBody(response, 8)).rejects.toThrow("exceeding this call's 8-byte budget")
    expect(bodyRead).toBe(false)
  })
})
