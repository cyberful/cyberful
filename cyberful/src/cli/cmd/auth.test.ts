// ── Pi Provider Authentication Command Tests ────────────────────
// Verifies configured routing, secret-free output, authentication source
//   reporting, credential removal, and safe terminal/browser interaction.
// → cyberful/src/cli/cmd/auth.ts — owns the user-visible auth workflow.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import type { AuthInteraction, Credential } from "@earendil-works/pi-ai"
import { Settings } from "@/config/settings"
import {
  createTerminalAuthInteraction,
  runAuthCommand,
  type AuthCommandServices,
  type AuthModels,
  type AuthTerminal,
} from "./auth"

const subscriptionSettings = Settings.parse(Settings.DEFAULT_YAML)

const fallbackSettings = Settings.parse(`version: 1

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
      context_window: 1000000
      max_output_tokens: 131072

instructions:
  persona_roots: []
  skill_roots: []
  allow_project_discovery: false
`)

const namedKimiSettings = Settings.parse(`version: 1
agent:
  subsystem: pi
  main_provider: moonshot-plan
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
    moonshot-plan:
      adapter: kimi-coding
      model: k3
      auth:
        type: subscription
instructions:
  persona_roots: []
  skill_roots: []
  allow_project_discovery: false
`)

function oauthCredential(): Credential {
  return {
    type: "oauth",
    access: "access-material-must-not-print",
    refresh: "refresh-material-must-not-print",
    expires: Date.now() + 60_000,
  }
}

function authHarness(input: {
  readonly settings?: Settings.Info
  readonly models?: Partial<AuthModels>
  readonly interaction?: AuthInteraction
}) {
  const output: string[] = []
  const calls = {
    settingsDirectory: "",
    loginProvider: "",
    logoutProvider: "",
    interactionCreated: 0,
  }
  const models: AuthModels = {
    checkAuth: input.models?.checkAuth ?? (async () => undefined),
    login:
      input.models?.login ??
      (async (providerID) => {
        calls.loginProvider = providerID
        return oauthCredential()
      }),
    logout:
      input.models?.logout ??
      (async (providerID) => {
        calls.logoutProvider = providerID
      }),
  }
  const services: AuthCommandServices = {
    async loadSettings(directory) {
      calls.settingsDirectory = directory
      return input.settings ?? subscriptionSettings
    },
    createModels: () => models,
    createInteraction() {
      calls.interactionCreated += 1
      return {
        interaction:
          input.interaction ??
          ({
            prompt: async () => "browser",
            notify() {},
          } satisfies AuthInteraction),
        async close() {},
      }
    },
    write: (text) => output.push(text),
  }
  return { calls, output, services }
}

describe("auth command", () => {
  test("uses the main provider key by default without printing returned subscription credentials", async () => {
    const harness = authHarness({})

    await runAuthCommand({ action: "login", directory: "/workspace/project" }, harness.services)

    expect(harness.calls.settingsDirectory).toBe("/workspace/project")
    expect(harness.calls.loginProvider).toBe("openai-codex")
    expect(harness.calls.interactionCreated).toBe(1)
    expect(harness.output.join("")).toContain("Authenticated provider openai-codex")
    expect(harness.output.join("")).not.toContain("access-material")
    expect(harness.output.join("")).not.toContain("refresh-material")
  })

  test("does not reflect provider response material when subscription login fails", async () => {
    const harness = authHarness({
      models: {
        login: async () => {
          throw new Error("upstream included secret-access-token")
        },
      },
    })

    let failure: unknown
    try {
      await runAuthCommand({ action: "login", directory: "/workspace/project" }, harness.services)
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("Subscription login failed for provider 'openai-codex'")
    expect(String(failure)).not.toContain("secret-access-token")
  })

  test("logs in the subscription provider selected by its settings key", async () => {
    const harness = authHarness({ settings: namedKimiSettings })

    await runAuthCommand(
      {
        action: "login",
        directory: "/workspace/project",
        provider: "moonshot-plan",
      },
      harness.services,
    )

    expect(harness.calls.loginProvider).toBe("moonshot-plan")
    expect(harness.output.join("")).toContain("Authenticated provider moonshot-plan")
  })

  test("reports the selected provider, route, and active environment source", async () => {
    const harness = authHarness({
      settings: fallbackSettings,
      models: {
        checkAuth: async () => ({ type: "api_key", source: "ZAI_API_KEY" }),
      },
    })

    await runAuthCommand(
      {
        action: "status",
        directory: "/workspace/project",
        provider: "glm-5-2",
        format: "json",
      },
      harness.services,
    )

    const output = harness.output.join("")
    expect(output).toContain('"provider": "glm-5-2"')
    expect(output).toContain('"route": "fallback"')
    expect(output).toContain('"configuredAuth": "environment"')
    expect(output).toContain('"configuredSource": "environment variable ZAI_API_KEY"')
    expect(output).toContain('"activeSource": "ZAI_API_KEY"')
    expect(harness.calls.interactionCreated).toBe(0)
  })

  test("removes only the selected configured provider credential", async () => {
    const harness = authHarness({ settings: fallbackSettings })

    await runAuthCommand({ action: "logout", directory: "/workspace/project", provider: "glm-5-2" }, harness.services)

    expect(harness.calls.logoutProvider).toBe("glm-5-2")
    expect(harness.output.join("")).toContain("Removed Cyberful credentials for provider glm-5-2")
  })

  test("rejects unknown providers before creating model or interaction state", async () => {
    const harness = authHarness({})

    await expect(
      runAuthCommand(
        { action: "status", directory: "/workspace/project", provider: "not-configured" },
        harness.services,
      ),
    ).rejects.toThrow("not configured in settings.yaml")
    expect(harness.calls.interactionCreated).toBe(0)
  })

  test("directs environment-auth providers to their configured variable", async () => {
    const harness = authHarness({ settings: fallbackSettings })

    await expect(
      runAuthCommand({ action: "login", directory: "/workspace/project", provider: "glm-5-2" }, harness.services),
    ).rejects.toThrow("set ZAI_API_KEY instead")
    expect(harness.calls.interactionCreated).toBe(0)
  })
})

describe("terminal OAuth interaction", () => {
  test("supports default selection, hidden codes, and safe browser opening", async () => {
    const writes: string[] = []
    const opened: string[] = []
    const prompts: Array<{ readonly label: string; readonly secret: boolean }> = []
    const answers = ["", "authorization-code"]
    const terminal: AuthTerminal = {
      async ask(input) {
        prompts.push({ label: input.label, secret: input.secret })
        return answers.shift() ?? ""
      },
      write: (text) => writes.push(text),
      async openUrl(url) {
        opened.push(url)
      },
    }
    const session = createTerminalAuthInteraction(terminal)

    const selection = await session.interaction.prompt({
      type: "select",
      message: "Choose method",
      options: [
        { id: "browser", label: "Browser" },
        { id: "device", label: "Device" },
      ],
    })
    const code = await session.interaction.prompt({
      type: "manual_code",
      message: "Paste code",
      placeholder: "http://localhost/callback",
    })
    session.interaction.notify({
      type: "auth_url",
      url: "https://auth.example.test/authorize",
      instructions: "Complete login.",
    })
    session.interaction.notify({
      type: "auth_url",
      url: "javascript:alert(1)",
    })
    await session.close()

    expect(selection).toBe("browser")
    expect(code).toBe("authorization-code")
    expect(prompts.map((prompt) => prompt.secret)).toEqual([false, true])
    expect(opened).toEqual(["https://auth.example.test/authorize"])
    expect(writes.join("")).toContain("did not open an unsupported authentication URL")
    expect(writes.join("")).not.toContain("authorization-code")
  })
})
