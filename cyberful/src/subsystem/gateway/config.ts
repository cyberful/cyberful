// ── Private Phase Gateway Configuration ─────────────────────────
// Builds host-owned MCP registrations for primary and local fallback attempts,
// separating safe process settings from owner-private environment, lifecycle
// signals, and the default-deny tool profile selected for that exact attempt.
// → cyberful/src/subsystem/phase-runner.ts — creates one descriptor for each phase.
// → cyberful/src/subsystem/gateway/tool-profile.ts — validates profile names.
// @docs/runtimes/fallback-inference.md
// ─────────────────────────────────────────────────────────────────

import path from "path"
import type { SubsystemMcpServer } from "../provider"
import type { ToolProfile } from "./tool-profile"

export interface GatewayOptions {
  proxy?: boolean
  phase?: string
  // Host-owned gateway PID registration path.
  pidSignalPath?: string
  // Host-owned handoff request and expected successor.
  handoff?: { phase: string; successor?: string; signalPath: string }
  // Exposes native MCP elicitation for blocking human questions.
  questionEnabled?: boolean
  // Engagement-stable CAPTCHA circuit-breaker state.
  circuitBreakerPath?: string
  // Full for the primary phase; compact default-deny surfaces for local fallback attempts.
  toolProfile?: ToolProfile
  // Owner-private per-run environment overrides.
  env?: Readonly<Record<string, string>>
}

// ── Gateway Secrets Never Enter Codex Arguments ──────────────────
// The standalone gateway cannot depend on inheriting the TUI environment, but
// forwarding the whole environment would expose unrelated host credentials.
// Only the browser namespace and explicit engagement values enter privateEnv.
// The CLI materializes that map in an owner-only file; Codex receives only its
// path, and per-run values deliberately override the browser defaults.
// ──────────────────────────────────────────────────────────────
function browserRuntimeEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[0].startsWith("CYBER_BROWSER_") && entry[1] !== undefined,
    ),
  )
}

declare global {
  const CYBERFUL_BUILT: string
}

// ── Compiled Gateways Re-Enter Through The Main Binary ────────────
// Bun assigns unstable paths to split secondary chunks, and a source path would
// be resolved from the Expert workarea rather than the installation. A compiled
// gateway therefore re-runs the binary with one private dispatch token. Source
// development instead launches the module by its absolute import-meta path.
// Both forms are independent of caller cwd and reach the same gateway main.
// ──────────────────────────────────────────────────────────────
const isCompiledBinary = typeof CYBERFUL_BUILT !== "undefined"

// Sentinel argv token the main entrypoint dispatches on to run the gateway in-process.
export const GATEWAY_ARGV = "__cyberful-subsystem-gateway__"

function gatewaySpawn(): { command: string; args: string[]; bunBeBun: boolean } {
  if (isCompiledBinary) return { command: process.execPath, args: [GATEWAY_ARGV], bunBeBun: false }
  return { command: process.execPath, args: [path.join(import.meta.dir, "server.ts")], bunBeBun: true }
}

// ── Each Gateway Carries One Session Capability Set ───────────────
// Session identity limits variable access to one engagement, while phase and
// lifecycle paths bind handoff, questions, PID registration, and CAPTCHA state.
// Proxy mode adds only the approved upstream tools for that phase. Every value
// required by the gateway remains in privateEnv, preserving the distinction
// between model-visible MCP registration and host-owned capabilities.
// ──────────────────────────────────────────────────────────────
export function gatewayMcpServer(sessionID: string, opts?: GatewayOptions): SubsystemMcpServer {
  const { command, args, bunBeBun } = gatewaySpawn()
  const phase = opts?.phase ?? opts?.handoff?.phase
  return {
    name: "expert-gateway",
    command,
    args,
    env: {
      ...(bunBeBun ? { BUN_BE_BUN: "1" } : {}),
    },
    privateEnv: {
      ...browserRuntimeEnv(),
      ...(opts?.env ?? {}),
      CYBERFUL_SUBSYSTEM_SESSION: sessionID,
      ...(phase ? { CYBERFUL_SUBSYSTEM_PHASE: phase } : {}),
      ...(opts?.proxy ? { CYBERFUL_SUBSYSTEM_GATEWAY_PROXY: "1" } : {}),
      ...(opts?.pidSignalPath ? { CYBERFUL_SUBSYSTEM_GATEWAY_PID_PATH: opts.pidSignalPath } : {}),
      ...(opts?.questionEnabled ? { CYBERFUL_SUBSYSTEM_QUESTION_ENABLED: "1" } : {}),
      ...(opts?.circuitBreakerPath ? { CYBERFUL_SUBSYSTEM_CIRCUIT_BREAKER_PATH: opts.circuitBreakerPath } : {}),
      ...(opts?.toolProfile ? { CYBERFUL_SUBSYSTEM_TOOL_PROFILE: opts.toolProfile } : {}),
      ...(opts?.handoff
        ? {
            CYBERFUL_SUBSYSTEM_HANDOFF_PATH: opts.handoff.signalPath,
            ...(opts.handoff.successor
              ? { CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR: opts.handoff.successor }
              : { CYBERFUL_SUBSYSTEM_HANDOFF_TERMINAL: "1" }),
          }
        : {}),
    },
  }
}

export * as SubsystemGateway from "./config"
