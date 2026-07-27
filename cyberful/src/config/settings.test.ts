// ── Pi Runtime Settings Contract Tests ──────────────────────────
// Verifies first-run defaults, strict YAML validation, provider routing, and
//   rejection of inline secrets through the public settings loader.
// → cyberful/src/config/settings.ts — owns the behavior under test.
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Settings } from "./settings"

const temporaryDirectories: string[] = []

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cyberful-settings-"))
  temporaryDirectories.push(directory)
  return directory
}

function validSettings(extra = "") {
  return `version: 1
agent:
  subsystem: pi
  primary_provider: primary
  subagents:
    enabled: true
    max_per_run: 4
    max_concurrent: 2
    max_depth: 2
  fallback:
    proactive:
      enabled: false
      percentage: 2
    automatic_security_block:
      enabled: false
  providers:
    primary:
      adapter: openai-codex
      model: gpt-5.4
      auth:
        type: oauth
        profile: default
instructions:
  persona_roots: []
  skill_roots: []
  allow_project_discovery: false
${extra}`
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("Settings", () => {
  test("creates and loads a secret-free OpenAI Codex OAuth default", async () => {
    const directory = await temporaryDirectory()

    const settings = await Settings.load(directory)
    const filePath = path.join(directory, "settings.yaml")
    const text = await readFile(filePath, "utf8")

    expect(settings.agent.subsystem).toBe("pi")
    expect(settings.agent.primary_provider).toBe("openai-codex")
    expect(settings.agent.fallback_provider).toBeUndefined()
    expect(settings.agent.fallback.proactive.enabled).toBe(false)
    expect(settings.agent.fallback.automatic_security_block.enabled).toBe(false)
    expect(settings.agent.providers["openai-codex"]).toMatchObject({
      adapter: "openai-codex",
      model: "gpt-5.4",
      auth: { type: "oauth", profile: "default" },
    })
    expect(text).toBe(Settings.DEFAULT_YAML)
    expect(text).not.toMatch(/api[_-]?key|access[_-]?token|refresh[_-]?token/i)
    if (process.platform !== "win32") expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })

  test("loads idempotently without replacing an existing file", async () => {
    const directory = await temporaryDirectory()
    const filePath = path.join(directory, "settings.yaml")
    const text = validSettings()
    await writeFile(filePath, text)

    const first = await Settings.load(directory)
    const second = await Settings.load(directory)

    expect(first).toEqual(second)
    expect(first.agent.primary_provider).toBe("primary")
    expect(await readFile(filePath, "utf8")).toBe(text)
  })

  test("concurrent first loads share one complete default", async () => {
    const directory = await temporaryDirectory()

    const settings = await Promise.all(Array.from({ length: 8 }, () => Settings.load(directory)))

    expect(settings.every((item) => item.agent.primary_provider === "openai-codex")).toBe(true)
    expect(await readFile(path.join(directory, "settings.yaml"), "utf8")).toBe(Settings.DEFAULT_YAML)
  })

  test("accepts a configured OpenAI-compatible fallback", () => {
    const settings = Settings.parse(`version: 1
agent:
  subsystem: pi
  primary_provider: openai-codex
  fallback_provider: glm-5-2
  subagents:
    enabled: true
    max_per_run: 4
    max_concurrent: 2
    max_depth: 2
  fallback:
    proactive:
      enabled: true
      percentage: 2
    automatic_security_block:
      enabled: true
  providers:
    openai-codex:
      adapter: openai-codex
      model: gpt-5.4
      auth:
        type: oauth
        profile: default
    glm-5-2:
      adapter: openai-completions
      base_url: https://api.z.ai/api/paas/v4
      model: glm-5.2
      auth:
        type: environment
        variable: ZAI_API_KEY
      context_window: 131072
      max_output_tokens: 8192
instructions:
  persona_roots: []
  skill_roots: []
  allow_project_discovery: false
`)

    expect(settings.agent.fallback_provider).toBe("glm-5-2")
    expect(settings.agent.providers["glm-5-2"]?.auth).toEqual({
      type: "environment",
      variable: "ZAI_API_KEY",
    })
  })

  test("rejects empty and dangling provider routing", () => {
    expect(() =>
      Settings.parse(
        validSettings().replace(
          `  providers:
    primary:
      adapter: openai-codex
      model: gpt-5.4
      auth:
        type: oauth
        profile: default`,
          "  providers: {}",
        ),
      ),
    ).toThrow("agent.providers must contain at least one provider")

    expect(() =>
      Settings.parse(validSettings().replace("primary_provider: primary", "primary_provider: missing")),
    ).toThrow('agent.primary_provider references unconfigured provider "missing"')
  })

  test("requires a distinct configured provider before enabling fallback", () => {
    expect(() =>
      Settings.parse(
        validSettings()
          .replace("primary_provider: primary", "primary_provider: primary\n  fallback_provider: primary")
          .replace("enabled: false\n      percentage", "enabled: true\n      percentage"),
      ),
    ).toThrow("agent.fallback_provider must be different from agent.primary_provider")

    expect(() =>
      Settings.parse(validSettings().replace("enabled: false\n      percentage", "enabled: true\n      percentage")),
    ).toThrow("agent.fallback_provider is required")
  })

  test("rejects unknown keys at every schema level", () => {
    expect(() => Settings.parse(validSettings("  untrusted_instruction: true\n"))).toThrow(
      /instructions\.untrusted_instruction/,
    )
    expect(() =>
      Settings.parse(validSettings().replace("profile: default", "profile: default\n        api_version: hidden")),
    ).toThrow(/agent\.providers\.primary\.auth\.api_version/)
  })

  test("keeps ambient project instruction discovery permanently disabled", () => {
    expect(() =>
      Settings.parse(
        Settings.DEFAULT_YAML.replace("allow_project_discovery: false", "allow_project_discovery: true"),
        "settings.yaml",
      ),
    ).toThrow("allow_project_discovery")
  })

  test("rejects inline secrets without reflecting their values", () => {
    const secret = "do-not-print-this-value"
    let error: unknown
    try {
      Settings.parse(validSettings().replace("profile: default", `profile: default\n        api_key: ${secret}`))
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Settings.InvalidError)
    expect(String(error)).toContain("contains an inline secret")
    expect(String(error)).not.toContain(secret)
  })

  test("rejects credentials embedded in provider URLs", () => {
    expect(() =>
      Settings.parse(
        validSettings().replace(
          "adapter: openai-codex",
          "adapter: openai-completions\n      base_url: https://user:password@example.test/v1",
        ),
      ),
    ).toThrow("base_url must not contain inline credentials")
  })

  test("reports malformed YAML without echoing the document", () => {
    const malformed = `${validSettings()}\nsecret-material: [`
    let error: unknown
    try {
      Settings.parse(malformed, "/engagement/settings.yaml")
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Settings.YamlError)
    expect(String(error)).toContain("/engagement/settings.yaml")
    expect(String(error)).not.toContain("secret-material")
  })
})
