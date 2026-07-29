// ── Pi Provider Authentication Commands ─────────────────────────
// Resolves configured provider keys into provider-owned subscription login,
//   status, and logout flows without exposing stored credential material.
// → cyberful/src/config/settings.ts — validates the configured provider routes.
// → cyberful/src/subsystem/pi-credentials.ts — owns owner-only credential persistence.
// ─────────────────────────────────────────────────────────────────

import type { AuthCheck, AuthEvent, AuthInteraction, AuthPrompt, Credential } from "@earendil-works/pi-ai"
import { Settings } from "@/config/settings"
import { PiCredentialStore } from "@/subsystem/pi-credentials"
import { createPiModels } from "@/subsystem/pi-models"
import open from "open"
import { EOL } from "node:os"
import { createInterface } from "node:readline/promises"
import type { Argv } from "yargs"
import { cmd } from "./cmd"

export interface AuthModels {
  checkAuth(providerID: string): Promise<AuthCheck | undefined>
  login(providerID: string, interaction: AuthInteraction): Promise<Credential>
  logout(providerID: string): Promise<void>
}

export interface AuthInteractionSession {
  readonly interaction: AuthInteraction
  close(): Promise<void>
}

export interface AuthCommandServices {
  loadSettings(directory: string): Promise<Settings.Info>
  createModels(settings: Settings.Info): AuthModels
  createInteraction(): AuthInteractionSession
  write(text: string): void
}

export interface AuthCommandInput {
  readonly action: "login" | "status" | "logout"
  readonly directory: string
  readonly provider?: string
  readonly format?: "table" | "json"
}

export interface AuthTerminal {
  ask(input: { readonly label: string; readonly secret: boolean; readonly signal?: AbortSignal }): Promise<string>
  write(text: string): void
  openUrl(url: string): Promise<void>
}

interface AuthStatus {
  readonly provider: string
  readonly route: "main" | "fallback" | "configured"
  readonly model: string
  readonly configuredAuth: "subscription" | "environment"
  readonly configuredSource: string
  readonly available: boolean
  readonly activeSource: string | null
}

function authSignal(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (!first) return second
  if (!second) return first
  return AbortSignal.any([first, second])
}

async function visibleQuestion(label: string, signal?: AbortSignal): Promise<string> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY,
  })
  try {
    return await terminal.question(label, { signal })
  } finally {
    terminal.close()
  }
}

// ── Secret Prompts Never Echo Credential Material ───────────────
// Subscription providers may request an API key, authorization code, or
// redirect URL through the same interaction contract. On a TTY, Cyberful owns
// raw input and writes no entered characters; redirected stdin is already
// non-echoing and can use readline. Cleanup restores raw and paused state after
// success, cancellation, Ctrl-C, or an input-stream failure.
// ─────────────────────────────────────────────────────────────────
async function hiddenQuestion(label: string, signal?: AbortSignal): Promise<string> {
  const input = process.stdin
  if (!input.isTTY) return visibleQuestion(label, signal)
  if (typeof input.setRawMode !== "function")
    throw new Error("This terminal cannot securely accept authentication input")

  const wasRaw = input.isRaw
  const wasPaused = input.isPaused()
  process.stderr.write(label)
  input.setRawMode(true)

  return new Promise<string>((resolve, reject) => {
    let value = ""
    let settled = false

    const cleanup = () => {
      input.off("data", onData)
      input.off("end", onEnd)
      input.off("error", onError)
      signal?.removeEventListener("abort", onAbort)
      if (!wasRaw) input.setRawMode?.(false)
      if (wasPaused) input.pause()
    }
    const finish = (result: { readonly value: string } | { readonly error: Error }) => {
      if (settled) return
      settled = true
      cleanup()
      process.stderr.write(EOL)
      if ("error" in result) reject(result.error)
      else resolve(result.value)
    }
    const onError = (error: Error) => finish({ error })
    const onEnd = () => finish({ error: new Error("Authentication input closed") })
    const onAbort = () => finish({ error: new Error("Authentication cancelled") })
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          finish({ value })
          return
        }
        if (character === "\u0003") {
          finish({ error: new Error("Authentication cancelled") })
          return
        }
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("")
          continue
        }
        if (character >= " ") value += character
      }
    }

    input.on("data", onData)
    input.on("end", onEnd)
    input.on("error", onError)
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    input.resume()
  })
}

const defaultTerminal: AuthTerminal = {
  ask: ({ label, secret, signal }) => (secret ? hiddenQuestion(label, signal) : visibleQuestion(label, signal)),
  write: (text) => process.stderr.write(text),
  async openUrl(url) {
    await open(url, { wait: false })
  },
}

function promptLabel(prompt: AuthPrompt): string {
  const placeholder =
    (prompt.type === "text" || prompt.type === "manual_code") && prompt.placeholder ? ` (${prompt.placeholder})` : ""
  return `${prompt.message}${placeholder}: `
}

function browserUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function eventLines(event: AuthEvent): readonly string[] {
  if (event.type === "auth_url")
    return ["Open this URL in your browser:", event.url, ...(event.instructions ? [event.instructions] : [])]
  if (event.type === "device_code")
    return ["Open this URL in your browser:", event.verificationUri, `Enter code: ${event.userCode}`]
  if (event.type === "info")
    return [event.message, ...(event.links ?? []).map((link) => `${link.label ? `${link.label}: ` : ""}${link.url}`)]
  return [event.message]
}

export function createTerminalAuthInteraction(
  terminal: AuthTerminal = defaultTerminal,
  signal?: AbortSignal,
): AuthInteractionSession {
  const browserTasks: Promise<void>[] = []

  return {
    interaction: {
      signal,
      async prompt(prompt) {
        if (prompt.type === "select") {
          terminal.write(`${EOL}${prompt.message}${EOL}`)
          prompt.options.forEach((option, index) => {
            terminal.write(`  ${index + 1}. ${option.label}${EOL}`)
            if (option.description) terminal.write(`     ${option.description}${EOL}`)
          })
          const answer = (
            await terminal.ask({
              label: `Enter number (1-${prompt.options.length}) [1]: `,
              secret: false,
              signal: authSignal(signal, prompt.signal),
            })
          ).trim()
          const selected =
            answer === ""
              ? prompt.options[0]
              : (prompt.options[Number.parseInt(answer, 10) - 1] ??
                prompt.options.find((option) => option.id === answer))
          if (!selected) throw new Error("Invalid authentication selection")
          return selected.id
        }

        const secret = prompt.type === "secret" || prompt.type === "manual_code"
        const answer = await terminal.ask({
          label: promptLabel(prompt),
          secret,
          signal: authSignal(signal, prompt.signal),
        })
        return secret ? answer : answer.trim()
      },
      notify(event) {
        terminal.write(`${EOL}${eventLines(event).join(EOL)}${EOL}`)
        const rawUrl =
          event.type === "auth_url" ? event.url : event.type === "device_code" ? event.verificationUri : undefined
        if (!rawUrl) return
        const url = browserUrl(rawUrl)
        if (!url) {
          terminal.write(`Cyberful did not open an unsupported authentication URL.${EOL}`)
          return
        }
        browserTasks.push(
          terminal.openUrl(url).catch(() => {
            terminal.write(`Cyberful could not open the browser; use the URL shown above.${EOL}`)
          }),
        )
      },
    },
    async close() {
      await Promise.all(browserTasks)
    },
  }
}

const defaultServices: AuthCommandServices = {
  loadSettings: Settings.load,
  createModels(settings) {
    const registry = createPiModels(settings.agent, new PiCredentialStore())
    return {
      async checkAuth(providerID) {
        const resolved = await registry.models.getAuth(registry.model(providerID))
        if (!resolved) return
        const configured = settings.agent.providers[providerID]
        return {
          type:
            configured?.auth.type === "subscription"
              ? registry.loginType(providerID)
              : "api_key",
          source: resolved.source,
        }
      },
      login: (providerID, interaction) =>
        registry.models.login(providerID, registry.loginType(providerID), interaction),
      logout: (providerID) => registry.models.logout(providerID),
    }
  },
  createInteraction: () => createTerminalAuthInteraction(),
  write: (text) => process.stdout.write(text),
}

function configuredProvider(settings: Settings.Info, requested?: string) {
  const providerID = requested?.trim() || settings.agent.main_provider
  const provider = settings.agent.providers[providerID]
  if (!provider) throw new Error(`Provider '${providerID}' is not configured in settings.yaml`)
  return { providerID, provider }
}

function statusRecord(
  settings: Settings.Info,
  providerID: string,
  provider: Settings.Provider,
  auth: AuthCheck | undefined,
): AuthStatus {
  const route =
    providerID === settings.agent.main_provider
      ? "main"
      : providerID === settings.agent.fallback_provider
        ? "fallback"
        : "configured"
  return {
    provider: providerID,
    route,
    model: provider.model,
    configuredAuth: provider.auth.type,
    configuredSource:
      provider.auth.type === "subscription"
        ? "provider subscription login"
        : `environment variable ${provider.auth.variable}`,
    available: auth !== undefined,
    activeSource: auth?.source ?? null,
  }
}

function formatStatus(status: AuthStatus, format: "table" | "json"): string {
  if (format === "json") return JSON.stringify(status, null, 2)
  return [
    `Provider: ${status.provider}`,
    `Route: ${status.route}`,
    `Model: ${status.model}`,
    `Configured auth: ${status.configuredAuth}`,
    `Configured source: ${status.configuredSource}`,
    `Status: ${status.available ? "available" : "missing"}`,
    `Active source: ${status.activeSource ?? "-"}`,
  ].join(EOL)
}

export async function runAuthCommand(
  input: AuthCommandInput,
  services: AuthCommandServices = defaultServices,
): Promise<void> {
  const settings = await services.loadSettings(input.directory)
  const { providerID, provider } = configuredProvider(settings, input.provider)
  const models = services.createModels(settings)

  if (input.action === "status") {
    const status = statusRecord(settings, providerID, provider, await models.checkAuth(providerID))
    services.write(`${formatStatus(status, input.format ?? "table")}${EOL}`)
    return
  }

  if (input.action === "logout") {
    await models.logout(providerID)
    services.write(`Removed Cyberful credentials for provider ${providerID}.${EOL}`)
    return
  }

  if (provider.auth.type !== "subscription")
    throw new Error(`Provider '${providerID}' uses environment authentication; set ${provider.auth.variable} instead`)

  const interaction = services.createInteraction()
  try {
    await models.login(providerID, interaction.interaction).catch(() => {
      throw new Error(`Subscription login failed for provider '${providerID}'; retry with cyberful auth login ${providerID}`)
    })
  } finally {
    await interaction.close()
  }
  services.write(`Authenticated provider ${providerID} using its configured subscription login.${EOL}`)
}

interface ProviderArgs {
  readonly provider?: string
}

interface StatusArgs extends ProviderArgs {
  readonly format: "table" | "json"
}

const providerBuilder = (yargs: Argv) =>
  yargs.positional("provider", {
    describe: "configured provider key (defaults to the main provider)",
    type: "string",
  })

export const AuthLoginCommand = cmd<{}, ProviderArgs>({
  command: "login [provider]",
  describe: "authenticate a configured subscription provider",
  builder: providerBuilder,
  handler: (args) =>
    runAuthCommand({
      action: "login",
      directory: process.cwd(),
      provider: args.provider,
    }),
})

export const AuthStatusCommand = cmd<{}, StatusArgs>({
  command: "status [provider]",
  describe: "show the configured and active authentication source",
  builder: (yargs) =>
    providerBuilder(yargs).option("format", {
      describe: "output format",
      type: "string",
      choices: ["table", "json"] as const,
      default: "table" as const,
    }),
  handler: (args) =>
    runAuthCommand({
      action: "status",
      directory: process.cwd(),
      provider: args.provider,
      format: args.format,
    }),
})

export const AuthLogoutCommand = cmd<{}, ProviderArgs>({
  command: "logout [provider]",
  describe: "remove Cyberful credentials for a configured provider",
  builder: providerBuilder,
  handler: (args) =>
    runAuthCommand({
      action: "logout",
      directory: process.cwd(),
      provider: args.provider,
    }),
})

export const AuthCommand = cmd({
  command: "auth",
  describe: "manage Pi provider authentication",
  builder: (yargs: Argv) =>
    yargs.command(AuthLoginCommand).command(AuthStatusCommand).command(AuthLogoutCommand).demandCommand(),
  async handler() {},
})
