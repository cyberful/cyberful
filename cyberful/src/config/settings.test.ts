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
  main_provider: main
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
    main:
      adapter: openai-codex
      model: gpt-5.6-sol
      auth:
        type: subscription
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
  test("creates and loads a secret-free OpenAI Codex subscription default", async () => {
    const directory = await temporaryDirectory()

    const settings = await Settings.load(directory)
    const filePath = path.join(directory, "settings.yaml")
    const text = await readFile(filePath, "utf8")

    expect(settings.agent.subsystem).toBe("pi")
    expect(settings.agent.main_provider).toBe("openai-codex")
    expect(settings.agent.reasoning_effort).toBe("ultra")
    expect(Settings.reasoningEffort(settings)).toBe("ultra")
    expect(settings.agent.fallback_provider).toBeUndefined()
    expect(settings.agent.compaction).toEqual(Settings.DEFAULT_COMPACTION)
    expect(Settings.compactionPolicy(settings)).toEqual(Settings.DEFAULT_COMPACTION)
    expect(settings.agent.retry).toEqual(Settings.DEFAULT_RETRY)
    expect(Settings.retryPolicy(settings)).toEqual(Settings.DEFAULT_RETRY)
    expect(Settings.subagentPolicy(settings)).toEqual({
      provider: "openai-codex",
      reasoning_efforts: ["xhigh", "medium"],
      default_reasoning_effort: "xhigh",
      source: "configured",
    })
    expect(settings.agent.fallback.proactive.enabled).toBe(false)
    expect(settings.agent.fallback.automatic_security_block.enabled).toBe(false)
    expect(Settings.phaseRecoveryPolicy(settings)).toEqual({
      enabled: true,
      max_restarts: 1,
      use_fallback_provider: true,
    })
    expect(settings.agent.providers["openai-codex"]).toMatchObject({
      adapter: "openai-codex",
      model: "gpt-5.6-sol",
      auth: { type: "subscription" },
    })
    expect(text).toBe(Settings.DEFAULT_YAML)
    expect(text).not.toMatch(/api[_-]?key|access[_-]?token|refresh[_-]?token/i)
    if (process.platform !== "win32") expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })

  test("adds the explicit ultra default once while preserving an existing file", async () => {
    const directory = await temporaryDirectory()
    const filePath = path.join(directory, "settings.yaml")
    const text = validSettings()
    await writeFile(filePath, text)

    const first = await Settings.load(directory)
    const second = await Settings.load(directory)

    expect(first).toEqual(second)
    expect(first.agent.main_provider).toBe("main")
    expect(first.agent.reasoning_effort).toBe("ultra")
    expect(Settings.reasoningEffort(first)).toBe("ultra")
    expect(first.agent.compaction).toBeUndefined()
    expect(Settings.compactionPolicy(first)).toEqual(Settings.DEFAULT_COMPACTION)
    expect(first.agent.retry).toBeUndefined()
    expect(Settings.retryPolicy(first)).toEqual(Settings.DEFAULT_RETRY)
    expect(await readFile(filePath, "utf8")).toBe(
      text
        .replace("  subsystem: pi\n", "  subsystem: pi\n  reasoning_effort: ultra\n")
        .replace("    enabled: true\n", "    enabled: true\n    reasoning_effort: [xhigh, medium]\n"),
    )
  })

  test("preserves a configured reasoning effort and rejects unknown levels", async () => {
    const directory = await temporaryDirectory()
    const filePath = path.join(directory, "settings.yaml")
    const configured = validSettings().replace(
      "  subsystem: pi\n",
      "  subsystem: pi\n  reasoning_effort: xhigh\n",
    )
    await writeFile(filePath, configured)

    expect(Settings.reasoningEffort(await Settings.load(directory))).toBe("xhigh")
    expect(await readFile(filePath, "utf8")).toBe(
      configured.replace("    enabled: true\n", "    enabled: true\n    reasoning_effort: [xhigh, medium]\n"),
    )
    expect(() =>
      Settings.parse(configured.replace("reasoning_effort: xhigh", "reasoning_effort: extreme")),
    ).toThrow(/agent\.reasoning_effort/)
  })

  test("accepts a bounded global retry policy and rejects invalid delays", () => {
    const configured = Settings.parse(
      validSettings().replace(
        "  fallback:",
        `  retry:
    enabled: false
    max_retries: 5
    base_delay_ms: 500
    max_delay_ms: 2000
    attempt_timeout_ms: 300000
  fallback:`,
      ),
    )
    expect(Settings.retryPolicy(configured)).toEqual({
      enabled: false,
      max_retries: 5,
      base_delay_ms: 500,
      max_delay_ms: 2_000,
      attempt_timeout_ms: 300_000,
      max_phase_extension_minutes: 15,
    })

    expect(() =>
      Settings.parse(
        validSettings().replace(
          "  fallback:",
          `  retry:
    enabled: true
    max_retries: 3
    base_delay_ms: 2000
    max_delay_ms: 1000
  fallback:`,
        ),
      ),
    ).toThrow("agent.retry.max_delay_ms must be greater than or equal to base_delay_ms")
    expect(() =>
      Settings.parse(
        validSettings().replace(
          "  fallback:",
          `  retry:
    enabled: true
    max_retries: 11
    base_delay_ms: 1000
    max_delay_ms: 15000
  fallback:`,
        ),
      ),
    ).toThrow(/agent\.retry\.max_retries/)
    expect(() =>
      Settings.parse(
        validSettings().replace(
          "  fallback:",
          `  retry:
    enabled: true
    max_retries: 3
    base_delay_ms: 1000
    max_delay_ms: 15000
    attempt_timeout_ms: 600001
  fallback:`,
        ),
      ),
    ).toThrow(/agent\.retry\.attempt_timeout_ms/)
  })

  test("resolves a dedicated subagent route and falls back explicitly for legacy settings", () => {
    const dedicated = Settings.parse(
      validSettings().replace(
        "    enabled: true\n",
        "    enabled: true\n    provider: main\n    reasoning_effort: [xhigh, medium]\n",
      ),
    )
    expect(Settings.subagentPolicy(dedicated)).toEqual({
      provider: "main",
      reasoning_efforts: ["xhigh", "medium"],
      default_reasoning_effort: "xhigh",
      source: "configured",
    })

    const legacy = Settings.parse(validSettings())
    expect(Settings.subagentPolicy(legacy)).toMatchObject({
      provider: "main",
      reasoning_efforts: ["xhigh", "medium"],
      default_reasoning_effort: "xhigh",
      source: "main-provider-fallback",
      warning: expect.stringContaining("inherit"),
    })

    expect(() =>
      Settings.parse(
        validSettings().replace(
          "    enabled: true\n",
          "    enabled: true\n    provider: missing\n",
        ),
      ),
    ).toThrow(/subagents\.provider references unconfigured provider/)
  })

  test("migrates scalar child reasoning and rejects ambiguous allowlists", async () => {
    const directory = await temporaryDirectory()
    const filePath = path.join(directory, "settings.yaml")
    const scalar = validSettings().replace(
      "    enabled: true\n",
      "    enabled: true\n    reasoning_effort: xhigh # legacy\n",
    )
    await writeFile(filePath, scalar)

    const settings = await Settings.load(directory)
    expect(Settings.subagentPolicy(settings)).toMatchObject({
      reasoning_efforts: ["xhigh"],
      default_reasoning_effort: "xhigh",
    })
    expect(await readFile(filePath, "utf8")).toContain(
      "    reasoning_effort: [xhigh] # legacy",
    )

    expect(
      Settings.subagentPolicy(
        Settings.parse(
          validSettings().replace(
            "    enabled: true\n",
            "    enabled: true\n    reasoning_effort: [xhigh]\n",
          ),
        ),
      ),
    ).toMatchObject({ reasoning_efforts: ["xhigh"], default_reasoning_effort: "xhigh" })
    expect(() =>
      Settings.parse(
        validSettings().replace(
          "    enabled: true\n",
          "    enabled: true\n    reasoning_effort: [medium]\n",
        ),
      ),
    ).toThrow("must include xhigh")
    expect(() =>
      Settings.parse(
        validSettings().replace(
          "    enabled: true\n",
          "    enabled: true\n    reasoning_effort: [xhigh, xhigh]\n",
        ),
      ),
    ).toThrow("must not contain duplicates")
  })

  test("accepts a conservative context compaction threshold and rejects unsafe percentages", () => {
    const configured = Settings.parse(
      validSettings().replace(
        "  fallback:",
        `  compaction:
    enabled: false
    trigger_percentage: 70
  fallback:`,
      ),
    )
    expect(Settings.compactionPolicy(configured)).toEqual({
      enabled: false,
      model_summary: true,
      target_percentage: 35,
      trigger_percentage: 70,
      summarizer: {
        provider: "inherit",
        reasoning_effort: "medium",
      },
    })
    const withSummarizer = Settings.parse(
      validSettings().replace(
        "  fallback:",
        `  compaction:
    enabled: true
    trigger_percentage: 75
    target_percentage: 35
    summarizer:
      provider: inherit
      reasoning_effort: high
  fallback:`,
      ),
    )
    expect(Settings.compactionPolicy(withSummarizer).summarizer).toEqual({
      provider: "inherit",
      reasoning_effort: "high",
    })

    expect(() =>
      Settings.parse(
        validSettings().replace(
          "  fallback:",
          `  compaction:
    enabled: true
    trigger_percentage: 90
  fallback:`,
        ),
      ),
    ).toThrow(/agent\.compaction\.trigger_percentage/)
    expect(() =>
      Settings.parse(
        validSettings().replace(
          "  fallback:",
          `  compaction:
    enabled: true
    trigger_percentage: 70
    target_percentage: 70
  fallback:`,
        ),
      ),
    ).toThrow(/target_percentage must be lower/)
    expect(() =>
      Settings.parse(
        validSettings().replace(
          "  fallback:",
          `  compaction:
    enabled: true
    trigger_percentage: 75
    target_percentage: 35
    summarizer:
      provider: missing
  fallback:`,
        ),
      ),
    ).toThrow(/summarizer\.provider references unconfigured provider/)
  })

  test("concurrent first loads share one complete default", async () => {
    const directory = await temporaryDirectory()

    const settings = await Promise.all(Array.from({ length: 8 }, () => Settings.load(directory)))

    expect(settings.every((item) => item.agent.main_provider === "openai-codex")).toBe(true)
    expect(settings.every((item) => item.agent.subagents.max_per_run === 5)).toBe(true)
    expect(settings.every((item) => item.agent.subagents.max_concurrent === 5)).toBe(true)
    expect(settings.every((item) => item.agent.subagents.timeout_minutes === 30)).toBe(true)
    expect(await readFile(path.join(directory, "settings.yaml"), "utf8")).toBe(Settings.DEFAULT_YAML)
  })

  test("accepts a configured OpenAI-compatible fallback", () => {
    const settings = Settings.parse(`version: 1
agent:
  subsystem: pi
  main_provider: openai-codex
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
      model: gpt-5.6-sol
      auth:
        type: subscription
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
    main:
      adapter: openai-codex
      model: gpt-5.6-sol
      auth:
        type: subscription`,
          "  providers: {}",
        ),
      ),
    ).toThrow("agent.providers must contain at least one provider")

    expect(() =>
      Settings.parse(validSettings().replace("main_provider: main", "main_provider: missing")),
    ).toThrow('agent.main_provider references unconfigured provider "missing"')
  })

  test("requires a distinct configured provider before enabling fallback", () => {
    expect(() =>
      Settings.parse(
        validSettings()
          .replace("main_provider: main", "main_provider: main\n  fallback_provider: main")
          .replace("enabled: false\n      percentage", "enabled: true\n      percentage"),
      ),
    ).toThrow("agent.fallback_provider must be different from agent.main_provider")

    expect(() =>
      Settings.parse(validSettings().replace("enabled: false\n      percentage", "enabled: true\n      percentage")),
    ).toThrow("agent.fallback_provider is required")
  })

  test("rejects unknown keys at every schema level", () => {
    expect(() => Settings.parse(validSettings("  untrusted_instruction: true\n"))).toThrow(
      /instructions\.untrusted_instruction/,
    )
    expect(() =>
      Settings.parse(validSettings().replace("type: subscription", "type: subscription\n        api_version: hidden")),
    ).toThrow(/agent\.providers\.main\.auth\.api_version/)
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
      Settings.parse(validSettings().replace("type: subscription", `type: subscription\n        api_key: ${secret}`))
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
