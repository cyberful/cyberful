// ── Pi System Message Wire Attestation ──────────────────────────
// Validates Pi provider payloads immediately before dispatch so Cyberful's
// compiled contract remains one authentic provider-level system instruction.
// → cyberful/src/subsystem/prompt-compiler.ts — supplies the immutable prompt and manifest hash.
// ─────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { CompiledAgentPrompt } from "./prompt-compiler"

export type FailureCode =
  | "prompt_manifest_mismatch"
  | "unsupported_provider_api"
  | "payload_not_object"
  | "system_degraded_to_user"
  | "invalid_responses_instruction"
  | "invalid_chat_instruction_count"
  | "invalid_chat_instruction_role"
  | "invalid_chat_instruction_content"
  | "invalid_anthropic_system"
  | "invalid_anthropic_instruction_message"
  | "invalid_system_occurrence_count"

export class SystemWireValidationError extends Error {
  readonly code: FailureCode
  readonly api: string
  readonly systemSha256: string

  constructor(code: FailureCode, api: string, systemSha256: string, detail?: string) {
    super(
      `Pi provider payload rejected (${code}; api=${api}; system_sha256=${systemSha256}${detail ? `; ${detail}` : ""})`,
    )
    this.name = "SystemWireValidationError"
    this.code = code
    this.api = api
    this.systemSha256 = systemSha256
  }
}

export interface GuardInput {
  readonly prompt: Pick<CompiledAgentPrompt, "system" | "manifest">
}

export type OnPayload = (payload: unknown, model: Model<Api>) => unknown

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return undefined

  const parts = value.map((part) => {
    if (typeof part === "string") return part
    const item = record(part)
    return typeof item?.text === "string" ? item.text : undefined
  })
  return parts.every((part) => part !== undefined) ? parts.join("") : undefined
}

function occurrences(value: string, expected: string): number {
  let count = 0
  let offset = 0
  while (true) {
    const index = value.indexOf(expected, offset)
    if (index < 0) return count
    count++
    offset = index + expected.length
  }
}

function systemOccurrences(payload: unknown, expected: string): number {
  const pending: unknown[] = [payload]
  const seen = new WeakSet<object>()
  let count = 0

  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value === "string") {
      count += occurrences(value, expected)
      continue
    }
    if (typeof value !== "object" || value === null || seen.has(value)) continue
    seen.add(value)
    if (Array.isArray(value)) {
      pending.push(...value)
      continue
    }
    pending.push(...Object.values(value))
  }
  return count
}

function messagesWithRole(payload: unknown, role: string): readonly Readonly<Record<string, unknown>>[] {
  const pending: unknown[] = [payload]
  const seen = new WeakSet<object>()
  const found: Readonly<Record<string, unknown>>[] = []

  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value !== "object" || value === null || seen.has(value)) continue
    seen.add(value)
    if (Array.isArray(value)) {
      pending.push(...value)
      continue
    }
    const item = value as Readonly<Record<string, unknown>>
    if (item.role === role) found.push(item)
    pending.push(...Object.values(item))
  }
  return found
}

function fail(code: FailureCode, model: Model<Api>, systemSha256: string, detail?: string): never {
  throw new SystemWireValidationError(code, model.api, systemSha256, detail)
}

// ── Provider Payload Is A Security Boundary ─────────────────────
// Pi constructs this object after Cyberful compiles and hashes the prompt but
// before transport, so the callback accepts only three reviewed wire contracts
// and returns the original object identity.
// It never serializes payloads or embeds prompt text in failures, preventing the attestation path from becoming a transcript or secret sink.
// Responses input is a tagged protocol union: a role alone does not identify a
// message because Pi anchors deferred tool definitions with role `developer`.
// Only the message variant is instruction-bearing; other typed input items stay
// owned by Pi's provider adapter and remain outside this prompt attestation.
// ─────────────────────────────────────────────────────────────────

function attestResponses(
  payload: Readonly<Record<string, unknown>>,
  model: Model<Api>,
  system: string,
  systemSha256: string,
): void {
  if (payload.instructions !== system)
    fail("invalid_responses_instruction", model, systemSha256, "instructions must equal the compiled system")

  const inputItems = Array.isArray(payload.input) ? payload.input : [payload.input]
  const instructionMessages = inputItems.map(record).filter((item) => {
    if (item?.role !== "system" && item?.role !== "developer") return false
    return item.type === undefined || item.type === "message"
  })
  if (instructionMessages.length > 0)
    fail("invalid_responses_instruction", model, systemSha256, "input must not contain an instruction message")
}

function attestChatCompletions(
  payload: Readonly<Record<string, unknown>>,
  model: Model<Api>,
  system: string,
  systemSha256: string,
): void {
  if (!Array.isArray(payload.messages))
    fail("invalid_chat_instruction_count", model, systemSha256, "messages must be an array")

  const instructionMessages = payload.messages
    .map(record)
    .filter((message): message is Readonly<Record<string, unknown>> => {
      return message?.role === "system" || message?.role === "developer"
    })
  if (instructionMessages.length !== 1)
    fail(
      "invalid_chat_instruction_count",
      model,
      systemSha256,
      `expected one instruction message, received ${instructionMessages.length}`,
    )

  const expectedRole = model.reasoning && record(model.compat)?.supportsDeveloperRole === true ? "developer" : "system"
  const instruction = instructionMessages[0]
  if (instruction.role !== expectedRole)
    fail(
      "invalid_chat_instruction_role",
      model,
      systemSha256,
      `expected role ${expectedRole}, received ${String(instruction.role)}`,
    )
  if (textContent(instruction.content) !== system)
    fail("invalid_chat_instruction_content", model, systemSha256, "instruction content must equal the compiled system")
}

function attestAnthropicMessages(
  payload: Readonly<Record<string, unknown>>,
  model: Model<Api>,
  system: string,
  systemSha256: string,
): void {
  if (!Array.isArray(payload.system) || payload.system.length !== 1) {
    const count = Array.isArray(payload.system) ? payload.system.length : 0
    fail(
      "invalid_anthropic_system",
      model,
      systemSha256,
      `expected one system text block, received ${count}`,
    )
  }

  const systemBlock = record(payload.system[0])
  if (systemBlock?.type !== "text" || systemBlock.text !== system)
    fail("invalid_anthropic_system", model, systemSha256, "system text must equal the compiled system")

  const nestedInstructionMessages = [
    ...messagesWithRole(payload.messages, "system"),
    ...messagesWithRole(payload.messages, "developer"),
  ]
  if (nestedInstructionMessages.length > 0)
    fail(
      "invalid_anthropic_instruction_message",
      model,
      systemSha256,
      "messages must not contain an additional instruction message",
    )
}

export function createOnPayload(input: GuardInput): OnPayload {
  const system = input.prompt.system
  const systemSha256 = sha256(system)
  if (!system.trim() || input.prompt.manifest.systemSha256 !== systemSha256)
    throw new SystemWireValidationError("prompt_manifest_mismatch", "unresolved", systemSha256)

  return (payload, model) => {
    const body = record(payload)
    if (!body) fail("payload_not_object", model, systemSha256)

    const userMessages = messagesWithRole(body, "user")
    if (userMessages.some((message) => textContent(message.content)?.includes(system)))
      fail("system_degraded_to_user", model, systemSha256)

    if (model.api === "openai-codex-responses") {
      attestResponses(body, model, system, systemSha256)
    } else if (model.api === "openai-completions") {
      attestChatCompletions(body, model, system, systemSha256)
    } else if (model.api === "anthropic-messages") {
      attestAnthropicMessages(body, model, system, systemSha256)
    } else {
      fail("unsupported_provider_api", model, systemSha256)
    }

    const count = systemOccurrences(body, system)
    if (count !== 1)
      fail("invalid_system_occurrence_count", model, systemSha256, `expected one occurrence, received ${count}`)
    return payload
  }
}

export * as PiSystemWire from "./pi-system-wire"
