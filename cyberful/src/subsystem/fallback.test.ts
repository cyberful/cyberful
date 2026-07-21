// ── Local Fallback Inference Configuration Tests ────────────────
// Protects the launch-directory YAML trust boundary, local-only endpoint policy,
// environment-secret resolution, and the degraded startup behavior operators see
// when an optional inference daemon is absent. Tests use real temporary files and
// inject only the external HTTP boundary, so no mutable developer state is read.
// → cyberful/src/subsystem/fallback.ts — owns parsing and preflight behavior.
// @docs/runtimes/fallback-inference.md
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { SubsystemFallback } from "./fallback"

const temporaryDirectories: string[] = []

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cyberful-fallback-config-"))
  temporaryDirectories.push(directory)
  return directory
}

async function configuration(contents: string) {
  const directory = await temporaryDirectory()
  await Bun.write(path.join(directory, "fallback-server.yaml"), contents)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("fallback-server.yaml", () => {
  test("the source checkout defaults to the ds4 Responses server", async () => {
    const repositoryRoot = path.resolve(import.meta.dir, "../../..")
    const contents = await Bun.file(path.join(repositoryRoot, "fallback-server.yaml")).text()
    expect(SubsystemFallback.parse(Bun.YAML.parse(contents))).toMatchObject({
      version: 1,
      enabled: true,
      protocol: "openai-responses",
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "deepseek-v4-flash",
    })
  })

  test("a missing file warns and disables fallback without probing the network", async () => {
    const directory = await temporaryDirectory()
    let calls = 0
    const result = await SubsystemFallback.load(directory, {
      request: async () => {
        calls += 1
        return new Response(null, { status: 200 })
      },
    })
    expect(result).toEqual({
      status: "disabled",
      reason: "missing",
      warning: "fallback-server.yaml is missing; local fallback inference is disabled for this run.",
    })
    expect(calls).toBe(0)
  })

  test("an explicitly disabled file does not require server fields", async () => {
    const directory = await configuration("version: 1\nenabled: false\n")
    await expect(SubsystemFallback.load(directory)).resolves.toEqual({
      status: "disabled",
      reason: "configured-off",
    })
  })

  test("a reachable local Responses server enables the fallback", async () => {
    const directory = await configuration([
      "version: 1",
      "enabled: true",
      "protocol: openai-responses",
      "base_url: http://127.0.0.1:8000/v1",
      "model: local-model",
      "api_key_env: LOCAL_FALLBACK_KEY",
      "system_prompt: Complete the bounded authorized task.",
      "",
    ].join("\n"))
    const requests: Array<{ url: string; authorization: string | null }> = []
    const result = await SubsystemFallback.load(directory, {
      environment: { LOCAL_FALLBACK_KEY: "private-key" },
      request: async (input, init) => {
        const headers = new Headers(init?.headers)
        requests.push({ url: String(input), authorization: headers.get("authorization") })
        return new Response("{}", { status: 200 })
      },
    })
    expect(result.status).toBe("available")
    expect(SubsystemFallback.publicDescriptor(result)).toEqual({
      status: "available",
      protocol: "openai-responses",
      model: "local-model",
    })
    expect(requests).toEqual([{ url: "http://127.0.0.1:8000/v1/models", authorization: "Bearer private-key" }])
  })

  test("an unreachable server warns and leaves the primary run available", async () => {
    const directory = await configuration([
      "version: 1",
      "enabled: true",
      "protocol: openai-responses",
      "base_url: http://localhost:8080/v1",
      "model: local-model",
      "",
    ].join("\n"))
    const result = await SubsystemFallback.load(directory, {
      request: async () => {
        throw new Error("connection refused")
      },
    })
    expect(result.status).toBe("unavailable")
    if (result.status !== "unavailable") throw new Error("expected unavailable fallback")
    expect(result.warning).toContain("primary run will continue")
    expect(result.warning).not.toContain("undefined")
  })

  test.each([
    ["remote endpoint", "base_url: https://example.com/v1", "loopback"],
    ["inline credentials", "base_url: http://user:pass@127.0.0.1:8000/v1", "credentials"],
    ["query parameters", "base_url: http://127.0.0.1:8000/v1?token=x", "query or fragment"],
    ["wrong protocol", "protocol: chat-completions", "openai-responses"],
    ["unknown keys", "extra: value", "unknown key"],
  ])("rejects %s", async (_label, replacement, expected) => {
    const base = [
      "version: 1",
      "enabled: true",
      "protocol: openai-responses",
      "base_url: http://127.0.0.1:8000/v1",
      "model: local-model",
    ]
    const key = replacement.split(":", 1)[0]
    const contents = [...base.filter((line) => !line.startsWith(`${key}:`)), replacement, ""].join("\n")
    const directory = await configuration(contents)
    await expect(SubsystemFallback.load(directory)).rejects.toThrow(expected)
  })

  test("requires the configured API key environment variable", async () => {
    const directory = await configuration([
      "version: 1",
      "enabled: true",
      "protocol: openai-responses",
      "base_url: http://127.0.0.1:8000/v1",
      "model: local-model",
      "api_key_env: MISSING_LOCAL_KEY",
      "",
    ].join("\n"))
    await expect(SubsystemFallback.load(directory, { environment: {} })).rejects.toThrow("MISSING_LOCAL_KEY")
  })

  test("rejects system prompts larger than eight KiB", async () => {
    const directory = await configuration([
      "version: 1",
      "enabled: true",
      "protocol: openai-responses",
      "base_url: http://127.0.0.1:8000/v1",
      "model: local-model",
      `system_prompt: ${"x".repeat(8 * 1024 + 1)}`,
      "",
    ].join("\n"))
    await expect(SubsystemFallback.load(directory)).rejects.toThrow("8192")
  })
})
