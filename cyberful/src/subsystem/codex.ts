// ── Codex Runtime Identity And Policy ────────────────────────────
// Defines the sole production phase subsystem's identity, effort, persona
// delegation, worker transport, settings attestation, and preflight verification.
// → cyberful/src/dependency/codex.ts — probes the installed Codex executable.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import { CODEX_PINNED_VERSION, codexInstallCommand, codexLoggedIn, codexVersionStatus } from "@/dependency/codex"
import { isRecord } from "@/util/record"
import * as Log from "@/util/log"
import matter from "gray-matter"

export const NAME = "codex" as const

export interface Descriptor {
  name: typeof NAME
  version: string
  label: string
}

export interface Runtime extends Descriptor {
  versionNote?: string
}

const VERSION_ENV = "CYBERFUL_CODEX_VERSION"
const VERSION_NOTE_ENV = "CYBERFUL_CODEX_VERSION_NOTE"
const EFFORT_ENV = "CYBERFUL_SUBSYSTEM_EFFORT"
export const DEFAULT_EFFORT = "xhigh"
export const MULTI_AGENT_MODE = "explicitRequestOnly"
const log = Log.create({ service: "subsystem.codex" })

export interface Persona {
  content: string
  subagents: number
}

export interface ThreadSettings {
  threadID: string
  effort: string | null
  multiAgentMode: string
}

// Reasoning effort is Codex application policy, not a subsystem capability. A future subsystem may
// decide how its own effort levels interact with persona delegation without inheriting this rule.
export function effort(env: Record<string, string | undefined> = process.env): string {
  return env[EFFORT_ENV]?.trim() || DEFAULT_EFFORT
}

// Persona frontmatter is configuration, never model prose. Missing metadata preserves compatibility
// with existing custom personas by resolving to the safe disabled value; malformed explicit values fail
// phase setup rather than silently changing delegation behavior.
export function parsePersona(source: string): Persona {
  const parsed = matter(source)
  const value = parsed.data.subagents
  if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0))
    throw new Error("persona frontmatter 'subagents' must be a non-negative integer")
  return { content: parsed.content.trim(), subagents: value ?? 0 }
}

export function delegationInstructions(subagents: number, requestedEffort = effort()): string {
  if (requestedEffort !== "ultra" || subagents === 0)
    return "Do not spawn subagents during this phase; complete the work directly."
  return [
    `Direct subagents are available for genuinely parallelizable work, with no more than ${subagents} subagents active at the same time.`,
    "When the phase instructions or user explicitly require a direct subagent, you must attempt that bounded spawn once; otherwise use delegation only when it materially helps.",
    'Give each subagent a self-contained, bounded, non-overlapping task and spawn it without parent history (`fork_turns: "none"`); wait for its result and remain solely responsible for synthesis, the phase deliverable, and handoff.',
    "If a child fails to initialize, do not repeat the delegation: continue that task directly and record the degraded delegation in the deliverable.",
  ].join("\n")
}

export function composeDeveloperInstructions(personaSource: string, sharedSource: string, requestedEffort = effort()) {
  const persona = parsePersona(personaSource)
  if (!persona.content) throw new Error("persona instruction file is empty")
  if (!sharedSource.trim()) throw new Error("shared instruction file is empty")
  return {
    subagents: persona.subagents,
    delegationEnabled: requestedEffort === "ultra" && persona.subagents > 0,
    instructions: [
      persona.content,
      `<CYBERFUL CODEX DELEGATION>\n${delegationInstructions(persona.subagents, requestedEffort)}\n</CYBERFUL CODEX DELEGATION>`,
      sharedSource.trim(),
    ].join("\n\n"),
  }
}

// The pinned Codex contract reports the effective turn policy before turn activity. multiAgentMode is deliberately
// observed, not requested: the protocol marks the request field deprecated and always resolves it to
// explicitRequestOnly, while Ultra plus explicit instructions controls proactive delegation.
export function threadSettings(event: unknown): ThreadSettings | undefined {
  if (!isRecord(event) || event.method !== "thread/settings/updated" || !isRecord(event.params)) return
  if (typeof event.params.threadId !== "string" || !isRecord(event.params.threadSettings)) return
  const settings = event.params.threadSettings
  return {
    threadID: event.params.threadId,
    effort: typeof settings.effort === "string" ? settings.effort : null,
    multiAgentMode: typeof settings.multiAgentMode === "string" ? settings.multiAgentMode : "",
  }
}

export function attestThreadSettings(
  settings: ThreadSettings,
  requestedEffort: string,
  threadID: string,
): string | undefined {
  if (settings.threadID !== threadID) return "Codex attested settings for a different thread."
  if (settings.effort !== requestedEffort)
    return `Codex resolved effort '${settings.effort ?? "null"}', expected '${requestedEffort}'.`
  if (settings.multiAgentMode !== MULTI_AGENT_MODE)
    return `Codex resolved multiAgentMode '${settings.multiAgentMode || "missing"}', expected '${MULTI_AGENT_MODE}'.`
}

const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR
const paint = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = (text: string) => paint("2", text)
const green = (text: string) => paint("32", text)
const yellow = (text: string) => paint("33", text)
const red = (text: string) => paint("31", text)

function line(text = "") {
  process.stderr.write(text + "\n")
}

export function descriptor(version: string): Descriptor {
  const resolved = version.trim() || CODEX_PINNED_VERSION
  return { name: NAME, version: resolved, label: `${NAME} v${resolved}` }
}

// The worker receives only subsystem-owned transport fields. Reading them back here keeps environment
// mechanics out of event publishers and TUI components; disabling the preflight deliberately falls back
// to the build-validated version.
export function runtimeDescriptor(env: Record<string, string | undefined> = process.env): Descriptor {
  return descriptor(env[VERSION_ENV] ?? CODEX_PINNED_VERSION)
}

export function preflightNote(env: Record<string, string | undefined> = process.env): string | undefined {
  return env[VERSION_NOTE_ENV]?.trim() || undefined
}

export function workerEnv(runtime: Runtime): Record<string, string> {
  return {
    [VERSION_ENV]: runtime.version,
    ...(runtime.versionNote ? { [VERSION_NOTE_ENV]: runtime.versionNote } : {}),
  }
}

export async function preflight(): Promise<Runtime> {
  if (process.env.CYBERFUL_SKIP_CODEX_PREFLIGHT) return descriptor(CODEX_PINNED_VERSION)

  line()
  line(dim("Cyberful preflight — Codex"))

  const version = await codexVersionStatus()
  if (version.status === "absent") {
    line(`  ${red("✗")} Codex CLI not found on PATH`)
    line(dim(`    Cyberful runs every phase through Codex ${CODEX_PINNED_VERSION}. Install it, then relaunch:`))
    line(`      ${codexInstallCommand()}`)
    line()
    log.warn("preflight: codex not on PATH")
    process.exit(1)
  }

  const runtime: Runtime =
    version.status === "mismatch"
      ? {
          ...descriptor(version.version),
          versionNote: `Codex ${version.version} · atteso ${CODEX_PINNED_VERSION}`,
        }
      : descriptor(version.version)

  if (version.status === "mismatch") {
    line(`  ${yellow("!")} Codex ${version.version} ${dim(`(validated against ${CODEX_PINNED_VERSION})`)}`)
    line(dim("    Proceeding — an untested version may fail on Codex config or protocol changes."))
    line(dim(`    To match: ${codexInstallCommand()}`))
    log.warn("preflight: codex version mismatch", { found: version.version, expected: CODEX_PINNED_VERSION })
  }
  if (version.status === "match") line(`  ${green("✓")} Codex ${version.version}`)

  if (!(await codexLoggedIn())) {
    line(`  ${red("✗")} Codex is not logged in`)
    line(dim("    Log in, then relaunch cyberful:"))
    line(`      codex login`)
    line()
    log.warn("preflight: codex not logged in")
    process.exit(1)
  }
  line(`  ${green("✓")} Codex logged in`)
  line()
  return runtime
}

export * as SubsystemCodex from "./codex"
