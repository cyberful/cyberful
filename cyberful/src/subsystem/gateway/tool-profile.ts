// ── Fallback Gateway Tool Profiles ───────────────────────────────
// Defines versioned, host-owned allowlists for compact local assist and recovery
// sessions. Profiles are default-deny and rely on first-party role metadata for
// isolated execution while keeping browser and ZAP selections explicit, so tool
// descriptions and model prose can never expand the fallback capability surface.
// → mcps/cyberful-os/cyberful_os_mcp.py — publishes isolated tool role metadata.
// → cyberful/src/subsystem/gateway/server.ts — enforces profiles at list and call.
// @docs/runtimes/fallback-inference.md
// ─────────────────────────────────────────────────────────────────

import type { SubsystemPhase } from "../phase"
import { isRecord } from "@/util/record"

export type ToolProfile = "full" | "fallback-assist" | "fallback-recovery"

const BROWSER_TOOLS = new Set([
  "browser_artifact_list",
  "browser_artifact_read",
  "browser_captcha_handoff",
  "browser_captcha_status",
  "browser_check",
  "browser_click",
  "browser_close",
  "browser_cookies",
  "browser_evaluate",
  "browser_fill",
  "browser_navigate",
  "browser_network_log",
  "browser_network_response_body",
  "browser_press",
  "browser_scroll",
  "browser_select",
  "browser_set_input_files",
  "browser_snapshot",
  "browser_status",
  "browser_type",
  "browser_wait",
])

const ZAP_TOOLS = new Set([
  "zap_api_call",
  "zap_http_request",
  "zap_history_search",
  "zap_history_get",
  "zap_websocket_history",
  "zap_context_auth",
])

const META_KEY = "cyberful.dev/tool-profile"

function metadataRoles(metadata: unknown): readonly string[] {
  if (!isRecord(metadata)) return []
  const envelope = metadata[META_KEY]
  if (!isRecord(envelope) || envelope.version !== 1 || !Array.isArray(envelope.roles)) return []
  return envelope.roles.filter((role): role is string => typeof role === "string")
}

export function parse(value: string | undefined): ToolProfile {
  if (!value) return "full"
  if (value === "full" || value === "fallback-assist" || value === "fallback-recovery") return value
  throw new Error(`Unknown Cyberful gateway tool profile '${value}'.`)
}

export function allowsUpstream(input: {
  readonly profile: ToolProfile
  readonly name: string
  readonly capability?: SubsystemPhase.WorkflowCapability
  readonly metadata?: unknown
}): boolean {
  if (input.profile === "full") return true
  if (input.capability === "browser") return BROWSER_TOOLS.has(input.name)
  if (input.capability === "zap") return ZAP_TOOLS.has(input.name)
  if (input.capability !== "isolated-exec") return false
  const roles = metadataRoles(input.metadata)
  if (input.profile === "fallback-assist") return roles.includes("shell") || roles.includes("evidence")
  return roles.includes("active") || roles.includes("shell") || roles.includes("evidence")
}

export function allowsLifecycle(profile: ToolProfile, name: "variable" | "question" | "handoff"): boolean {
  if (profile === "full") return true
  if (name === "handoff") return profile === "fallback-recovery"
  return true
}

export * as GatewayToolProfile from "./tool-profile"
