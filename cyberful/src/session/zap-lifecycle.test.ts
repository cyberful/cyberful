// ── Authorized AppSec ZAP Lifecycle Tests ───────────────────────
// Verifies that host authorization gates phase-scoped ZAP startup while
// Pentest retains its separate engagement-scoped lifecycle classification.
// → cyberful/src/session/prompt.ts — applies the tested lifecycle at phase boundaries.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import type { EngagementRuntime } from "@/subsystem/zap/runtime"
import type { PhaseResult, PhaseSpec } from "@/subsystem/phase-runner"
import { SessionID } from "./schema"
import { authorizedZapPhase, runAuthorizedPhaseZap, validRuntimeAuthorization, zapRuntimeLifecycle } from "./prompt"

const policy = (workflow: "assessment" | "remediate") => ({
  version: 1,
  workflow,
  origins: ["https://authorized.example"],
  maxToolCalls: 40,
  createdAt: "2026-07-16T10:00:00.000Z",
})

const phaseSpec = (workflow: string, phase: string): PhaseSpec => ({
  workflow,
  phase,
  sessionID: "ses_zap_lifecycle",
  workareaCwd: "/workarea",
  home: "/builtin",
  objective: "Inspect the authorized target.",
  timeoutMs: 60_000,
  env: { CYBERFUL_CODE_GRAPH_LEDGER_KEY: "private-ledger-key" },
})

const phaseResult = (phase: string): PhaseResult => ({
  phase,
  ok: true,
  summary: "done",
  exitCode: 0,
  timedOut: false,
  termination: "completed",
  backend: "codex",
  durationMs: 10,
  limitMs: 60_000,
  effectiveLimitMs: 60_000,
  deadlineAt: 60_000,
  warnings: [],
})

describe("host-authorized ZAP lifecycle", () => {
  test("classifies Pentest as engagement-scoped and limits AppSec startup phases", () => {
    expect(zapRuntimeLifecycle("pentest")).toBe("engagement")
    expect(zapRuntimeLifecycle("assessment")).toBe("authorized-phase")
    expect(zapRuntimeLifecycle("remediate")).toBe("authorized-phase")
    expect(zapRuntimeLifecycle("code-audit")).toBe("disabled")
    expect(zapRuntimeLifecycle("secure-review")).toBe("disabled")

    expect(authorizedZapPhase("assessment", "test")).toBe(true)
    expect(authorizedZapPhase("assessment", "map")).toBe(false)
    expect(authorizedZapPhase("remediate", "plan")).toBe(true)
    expect(authorizedZapPhase("remediate", "verify")).toBe(true)
    expect(authorizedZapPhase("remediate", "implement")).toBe(false)
  })

  test("accepts only a normalized, workflow-bound host policy", () => {
    expect(validRuntimeAuthorization(policy("assessment"), "assessment")).toBe(true)
    expect(validRuntimeAuthorization(policy("assessment"), "remediate")).toBe(false)
    expect(
      validRuntimeAuthorization(
        { ...policy("assessment"), origins: ["https://authorized.example/path"] },
        "assessment",
      ),
    ).toBe(false)
    expect(
      validRuntimeAuthorization(
        {
          ...policy("assessment"),
          origins: ["https://z.example", "https://a.example"],
        },
        "assessment",
      ),
    ).toBe(false)
    expect(validRuntimeAuthorization({ ...policy("assessment"), maxToolCalls: 2_001 }, "assessment")).toBe(false)
    expect(validRuntimeAuthorization({ ...policy("assessment"), createdAt: "invalid" }, "assessment")).toBe(false)
  })

  test("does not start before authorization or in a non-runtime phase", async () => {
    let starts = 0
    const start = async (): Promise<EngagementRuntime> => {
      starts += 1
      return { env: {}, degraded: false, stop: async () => {} }
    }
    const run = async (spec: PhaseSpec) => phaseResult(spec.phase)

    await runAuthorizedPhaseZap(
      {
        workflow: "assessment",
        policy: undefined,
        sessionID: SessionID.make("ses_no_policy"),
        workarea: "/workarea",
        spec: phaseSpec("assessment", "test"),
      },
      { start, run },
    )
    await runAuthorizedPhaseZap(
      {
        workflow: "assessment",
        policy: policy("assessment"),
        sessionID: SessionID.make("ses_wrong_phase"),
        workarea: "/workarea",
        spec: phaseSpec("assessment", "map"),
      },
      { start, run },
    )

    expect(starts).toBe(0)
  })

  test("passes only runtime descriptors and warnings to an authorized Assessment phase", async () => {
    let stops = 0
    let observed: PhaseSpec | undefined
    const result = await runAuthorizedPhaseZap(
      {
        workflow: "assessment",
        policy: policy("assessment"),
        sessionID: SessionID.make("ses_assessment"),
        workarea: "/workarea",
        spec: phaseSpec("assessment", "test"),
      },
      {
        start: async () => ({
          env: { CYBER_ZAP_CONTAINER: "zap-authorized", CYBER_ZAP_API_KEY: "opaque-key" },
          degraded: true,
          warning: "ZAP fell back to direct browser traffic.",
          stop: async () => {
            stops += 1
          },
        }),
        run: async (spec) => {
          observed = spec
          return phaseResult(spec.phase)
        },
      },
    )

    expect(observed?.env).toMatchObject({
      CYBERFUL_CODE_GRAPH_LEDGER_KEY: "private-ledger-key",
      CYBER_ZAP_CONTAINER: "zap-authorized",
      CYBER_ZAP_API_KEY: "opaque-key",
      CYBER_ZAP_ALLOWED_ORIGINS: '["https://authorized.example"]',
    })
    expect(observed?.objective).toContain("ZAP fell back")
    expect(result.warnings).toContain("ZAP fell back to direct browser traffic.")
    expect(stops).toBe(1)
  })

  test("starts and stops separately for Remediate Plan and Verify only", async () => {
    let starts = 0
    let stops = 0
    const start = async (): Promise<EngagementRuntime> => {
      starts += 1
      return {
        env: { CYBER_ZAP_CONTAINER: `zap-${starts}` },
        degraded: false,
        stop: async () => {
          stops += 1
        },
      }
    }
    const run = async (spec: PhaseSpec) => phaseResult(spec.phase)

    for (const phase of ["intake", "plan", "implement", "verify", "publish"]) {
      await runAuthorizedPhaseZap(
        {
          workflow: "remediate",
          policy: policy("remediate"),
          sessionID: SessionID.make("ses_remediate"),
          workarea: "/workarea",
          spec: phaseSpec("remediate", phase),
        },
        { start, run },
      )
    }

    expect(starts).toBe(2)
    expect(stops).toBe(2)
  })

  test("always attempts teardown when an authorized phase fails", async () => {
    let stopped = false
    await expect(
      runAuthorizedPhaseZap(
        {
          workflow: "assessment",
          policy: policy("assessment"),
          sessionID: SessionID.make("ses_failure"),
          workarea: "/workarea",
          spec: phaseSpec("assessment", "test"),
        },
        {
          start: async () => ({
            env: { CYBER_ZAP_CONTAINER: "zap-failure" },
            degraded: false,
            stop: async () => {
              stopped = true
            },
          }),
          run: async () => {
            throw new Error("phase failed")
          },
        },
      ),
    ).rejects.toThrow("phase failed")
    expect(stopped).toBe(true)
  })
})
