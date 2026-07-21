// ── Fallback Gateway Tool Profile Tests ─────────────────────────
// Protects the default-deny fallback inventory independently from model prompts,
// proving that first-party isolated roles, explicit browser/ZAP selections, and
// recovery-only handoff remain stable as the full gateway catalog evolves.
// → cyberful/src/subsystem/gateway/tool-profile.ts — owns profile decisions.
// @docs/runtimes/fallback-inference.md
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { GatewayToolProfile } from "./tool-profile"

const metadata = (roles: string[]) => ({ "cyberful.dev/tool-profile": { version: 1, roles } })

describe("fallback tool profiles", () => {
  test("assist exposes compact discovery while recovery retains active isolated tools", () => {
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "fallback-assist",
        name: "shell",
        capability: "isolated-exec",
        metadata: metadata(["shell"]),
      }),
    ).toBe(true)
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "fallback-assist",
        name: "tool_inventory",
        capability: "isolated-exec",
        metadata: metadata(["evidence"]),
      }),
    ).toBe(true)
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "fallback-assist",
        name: "sqlmap",
        capability: "isolated-exec",
        metadata: metadata(["active"]),
      }),
    ).toBe(false)
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "fallback-recovery",
        name: "sqlmap",
        capability: "isolated-exec",
        metadata: metadata(["active"]),
      }),
    ).toBe(true)
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "fallback-assist",
        name: "nmap",
        capability: "isolated-exec",
        metadata: metadata(["recon"]),
      }),
    ).toBe(false)
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "fallback-assist",
        name: "unclassified",
        capability: "isolated-exec",
      }),
    ).toBe(false)
  })

  test("browser interaction and active ZAP are explicit while catalogs and reports are absent", () => {
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "fallback-recovery",
        name: "browser_evaluate",
        capability: "browser",
      }),
    ).toBe(true)
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "fallback-recovery",
        name: "zap_http_request",
        capability: "zap",
      }),
    ).toBe(true)
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "fallback-recovery",
        name: "zap_api_catalog",
        capability: "zap",
      }),
    ).toBe(false)
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "fallback-recovery",
        name: "zap_generate_scoped_report",
        capability: "zap",
      }),
    ).toBe(false)
  })

  test("handoff belongs only to deterministic recovery", () => {
    expect(GatewayToolProfile.allowsLifecycle("fallback-assist", "variable")).toBe(true)
    expect(GatewayToolProfile.allowsLifecycle("fallback-assist", "question")).toBe(true)
    expect(GatewayToolProfile.allowsLifecycle("fallback-assist", "handoff")).toBe(false)
    expect(GatewayToolProfile.allowsLifecycle("fallback-recovery", "handoff")).toBe(true)
  })
})
