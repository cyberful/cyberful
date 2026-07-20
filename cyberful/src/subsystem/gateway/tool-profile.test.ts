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

describe("aggressive fallback tool profiles", () => {
  test("isolated tools require explicit first-party aggressive metadata", () => {
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "aggressive-assist",
        name: "shell",
        capability: "isolated-exec",
        metadata: metadata(["shell"]),
      }),
    ).toBe(true)
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "aggressive-assist",
        name: "nmap",
        capability: "isolated-exec",
        metadata: metadata(["recon"]),
      }),
    ).toBe(false)
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "aggressive-assist",
        name: "unclassified",
        capability: "isolated-exec",
      }),
    ).toBe(false)
  })

  test("browser interaction and active ZAP are explicit while catalogs and reports are absent", () => {
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "aggressive-recovery",
        name: "browser_evaluate",
        capability: "browser",
      }),
    ).toBe(true)
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "aggressive-recovery",
        name: "zap_http_request",
        capability: "zap",
      }),
    ).toBe(true)
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "aggressive-recovery",
        name: "zap_api_catalog",
        capability: "zap",
      }),
    ).toBe(false)
    expect(
      GatewayToolProfile.allowsUpstream({
        profile: "aggressive-recovery",
        name: "zap_generate_scoped_report",
        capability: "zap",
      }),
    ).toBe(false)
  })

  test("handoff belongs only to deterministic recovery", () => {
    expect(GatewayToolProfile.allowsLifecycle("aggressive-assist", "variable")).toBe(true)
    expect(GatewayToolProfile.allowsLifecycle("aggressive-assist", "question")).toBe(true)
    expect(GatewayToolProfile.allowsLifecycle("aggressive-assist", "handoff")).toBe(false)
    expect(GatewayToolProfile.allowsLifecycle("aggressive-recovery", "handoff")).toBe(true)
  })
})
