// ── Engagement Runtime Host Requirement Tests ─────────────────
// Verifies the Docker allocation boundary independently from a live daemon so
//   startup warnings cannot silently drift below the documented requirement.
// → cyberful/src/subsystem/engagement-runtime.ts — enforces the tested warning.
// ───────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { dockerMemoryAllocationWarning, requiresZapUpstream, zapCoreIsolationMounts } from "./engagement-runtime"

test("requires at least ten decimal gigabytes dedicated to Docker", () => {
  expect(dockerMemoryAllocationWarning("9999999999")).toContain("at least 10 GB")
  expect(dockerMemoryAllocationWarning("10000000000")).toBeUndefined()
  expect(() => dockerMemoryAllocationWarning("unknown")).toThrow("non-decimal")
})

test("requires ZAP for every live-target phase before a numeric policy exists", () => {
  expect(requiresZapUpstream("pentest")).toBe(true)
  expect(requiresZapUpstream("bug-bounty")).toBe(true)
  expect(requiresZapUpstream("ask")).toBe(false)
  expect(requiresZapUpstream("code-audit")).toBe(false)
  expect(requiresZapUpstream("ask", { global_http_rps: 4 })).toBe(true)
})

test("masks private ZAP state and exposes only a read-only public trust mount to the core", () => {
  expect(zapCoreIsolationMounts("/host/workarea/raw/zap/trust")).toEqual([
    "--mount",
    "type=tmpfs,destination=/workspace/raw/zap/runtime,tmpfs-size=1048576,tmpfs-mode=0700",
    "--mount",
    "type=bind,source=/host/workarea/raw/zap/trust,target=/workspace/raw/zap/trust,readonly",
    "--mount",
    "type=bind,source=/host/workarea/raw/zap/trust,target=/run/cyberful/proxy-trust,readonly",
  ])
})
