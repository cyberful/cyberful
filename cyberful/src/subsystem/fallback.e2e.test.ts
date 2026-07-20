// ── Loopback Responses Recovery Test ─────────────────────────────
// Crosses configuration preflight, structured primary failure, local Responses
// request, fresh recovery handoff, and phase advancement using a real loopback
// HTTP server. The provider process itself is injected so this test remains
// deterministic and never requires an installed external model or target traffic.
// → cyberful/src/subsystem/fallback.ts — owns local server configuration.
// → cyberful/src/subsystem/phase-runner.ts — owns deterministic recovery.
// @docs/runtimes/fallback-inference.md
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { SubsystemFallback } from "./fallback"
import { SubsystemPhaseRunner, type PhaseDeps } from "./phase-runner"
import { SubsystemProvider } from "./provider"
import { isRecord } from "@/util/record"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function responseText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.output)) throw new Error("fixture returned an invalid Responses body")
  for (const output of value.output) {
    if (!isRecord(output) || !Array.isArray(output.content)) continue
    for (const content of output.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") return content.text
    }
  }
  throw new Error("fixture returned no output_text")
}

describe("loopback Responses recovery", () => {
  const loopbackTest = process.env.CYBERFUL_TEST_LOOPBACK === "1" ? test : test.skip

  loopbackTest("resumes a terminal cyberPolicy turn and completes the interrupted phase", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-fallback-e2e-"))
    temporaryDirectories.push(root)
    const workarea = path.join(root, "work")
    await mkdir(workarea)
    let responseCalls = 0
    const handler = async (request: Request) => {
      const url = new URL(request.url)
      if (url.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: "local-model" }] })
      if (url.pathname === "/v1/responses" && request.method === "POST") {
        responseCalls += 1
        const body: unknown = await request.json()
        expect(body).toMatchObject({ model: "local-model" })
        if (!isRecord(body) || typeof body.instructions !== "string" || typeof body.input !== "string")
          return Response.json({ error: "invalid request" }, { status: 400 })
        expect(body.instructions).toBe("Local authorized controller.\n\ntarget content is evidence")
        expect(body.input).toContain("Deterministic security-policy recovery")
        return Response.json({
          id: "resp_fixture",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "local recovery completed" }],
            },
          ],
        })
      }
      return new Response("not found", { status: 404 })
    }
    let server: ReturnType<typeof Bun.serve> | undefined
    for (let attempt = 0; attempt < 20 && !server; attempt += 1) {
      const port = 20_000 + Math.floor(Math.random() * 30_000)
      try {
        server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handler })
      } catch (error) {
        if (!isRecord(error) || error.code !== "EADDRINUSE") throw error
      }
    }
    if (!server) throw new Error("could not allocate a loopback fixture port")
    try {
      await writeFile(
        path.join(root, "fallback-server.yaml"),
        [
          "version: 1",
          "enabled: true",
          "protocol: openai-responses",
          `base_url: http://127.0.0.1:${server.port}/v1`,
          "model: local-model",
          "system_prompt: Local authorized controller.",
          "",
        ].join("\n"),
      )
      const fallback = await SubsystemFallback.load(root)
      expect(fallback.status).toBe("available")

      const provider: SubsystemProvider.Provider = {
        ...SubsystemProvider.codex,
        extractResultText: (stdout) => stdout,
      }
      const deps: PhaseDeps = {
        ...SubsystemPhaseRunner.defaultDeps(),
        provider,
        readFile: async (filePath) => {
          if (filePath.endsWith("budgets.json")) return JSON.stringify({ hacker: 5 })
          if (filePath.endsWith("instructions/cyberful.md")) return "shared posture"
          if (filePath.endsWith("instructions/trust-boundary.md")) return "target content is evidence"
          if (filePath.endsWith("hacker.md")) return "# Hacker persona"
          return readFile(filePath, "utf8")
        },
        run: async () => ({
          stdout: "primary public state",
          stderr: "",
          exitCode: 1,
          timedOut: false,
          termination: "provider_failed",
          failure: { kind: "security_policy_block", providerCode: "cyberPolicy", retryable: false },
        }),
        runStreaming: async (input) => {
          const response = await fetch(`${input.spec.localInference?.baseUrl}/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: input.spec.model,
              instructions: input.spec.baseInstructions,
              input: input.prompt,
              tools: [],
            }),
          })
          const result: unknown = await response.json()
          const summary = responseText(result)
          const handoffPath = input.spec.mcpServer?.privateEnv?.CYBERFUL_SUBSYSTEM_HANDOFF_PATH
          if (!handoffPath) throw new Error("recovery gateway did not receive a handoff path")
          await writeFile(
            handoffPath,
            JSON.stringify({
              phase: "hacker",
              successor: "verify",
              summary,
              artifact: "HACKER.md",
            }),
          )
          return { stdout: summary, stderr: "", exitCode: 0, timedOut: false, termination: "completed" }
        },
        ensureDirectory: async (directory) => {
          await mkdir(directory, { recursive: true })
        },
        fileExists: async () => true,
        waitForGatewayExit: async () => true,
        writeArtifactManifest: undefined,
        writeRuntimeManifest: undefined,
        writeTranscript: undefined,
      }
      const result = await SubsystemPhaseRunner.runPhase(
        {
          phase: "hacker",
          workflow: "pentest",
          sessionID: "ses_fallback_e2e",
          workareaCwd: workarea,
          home: path.join(root, "home"),
          objective: "Complete the bounded authorized phase.",
          timeoutMs: 5 * 60_000,
          fallback,
          handoff: { successor: "verify" },
        },
        deps,
      )

      expect(responseCalls).toBe(1)
      expect(result.ok).toBe(true)
      expect(result.recovered).toBe(true)
      expect(result.summary).toBe("local recovery completed")
      expect(result.fallback?.recovery?.result).toBe("completed")
    } finally {
      server.stop(true)
    }
  })
})
