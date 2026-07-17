// ── Runtime Identity Contract Tests ─────────────────────────────
// Verifies that a running process exposes one stable, finite build and process
// identity through the same health payload consumed by control-plane clients.
// → cyberful/src/server/runtime-identity.ts — builds the tested payload.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { ensureProcessMetadata } from "@/util/cyberful-process"
import { InstallationBuildID, InstallationVersion } from "@/installation/version"
import { Exit, Schema } from "effect"
import { RuntimeIdentity } from "./runtime-identity"
import { GlobalHealth } from "./routes/instance/httpapi/groups/global"

describe("runtime identity", () => {
  test("is stable for the process and exposes the build and start boundary", () => {
    const first = ensureProcessMetadata("main")
    const second = ensureProcessMetadata("worker")

    expect(second).toEqual(first)
    if (InstallationBuildID !== "source-unbundled") expect(first.buildID).toBe(InstallationBuildID)
    expect(first.buildID.length).toBeGreaterThan(0)
    expect(first.runID.length).toBeGreaterThan(0)
    expect(first.pid).toBe(process.pid)
    expect(first.startedAt).toBeLessThanOrEqual(Date.now())
    expect(first.startedAt).toBeGreaterThan(Date.now() - process.uptime() * 1_000 - 1_000)
    if (InstallationVersion === "local" && !process.env.CYBERFUL_BUILD_ID)
      expect(first.buildID).toBe("source-unbundled")
  })

  test("the health contract exposes the same finite process identity", () => {
    const payload = RuntimeIdentity.healthPayload()
    expect(Exit.isSuccess(Schema.decodeUnknownExit(GlobalHealth)(payload))).toBe(true)
    const metadata = ensureProcessMetadata("main")
    expect(payload).toMatchObject({
      buildID: metadata.buildID,
      runID: metadata.runID,
      pid: metadata.pid,
      startedAt: metadata.startedAt,
    })
    expect(Exit.isFailure(Schema.decodeUnknownExit(GlobalHealth)({ ...payload, pid: Number.NaN }))).toBe(true)
    expect(
      Exit.isFailure(Schema.decodeUnknownExit(GlobalHealth)({ ...payload, startedAt: Number.POSITIVE_INFINITY })),
    ).toBe(true)
  })
})
