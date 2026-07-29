// ── Pi OAuth Standalone Bootstrap Contract ──────────────────────
// Compiles and executes the provider registry imported by the TUI Worker,
// proving OpenAI Codex OAuth remains available without the main entrypoint or
// runtime package files.
// → cyberful/src/subsystem/pi-models.ts — imports the registration invariant.
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Pi OAuth standalone bootstrap", () => {
  test(
    "compiled executables resolve OpenAI Codex OAuth without node_modules",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "cyberful-pi-oauth-"))
      temporaryRoots.push(root)
      const entrypoint = path.join(root, "probe.ts")
      const workerEntrypoint = path.join(root, "oauth-worker.ts")
      const outfile = path.join(root, process.platform === "win32" ? "oauth-probe.exe" : "oauth-probe")
      const modelsPath = path.join(import.meta.dir, "subsystem/pi-models.ts")
      const piPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"))

      await Bun.write(
        entrypoint,
        [
          "// ── Generated Compiled Worker Owner Probe ────────────────────────",
          "// Mirrors Cyberful's standalone main/Worker entrypoint separation.",
          "// ─────────────────────────────────────────────────────────────────",
          "declare const OAUTH_WORKER_PATH: string",
          "const worker = new Worker(OAUTH_WORKER_PATH)",
          "const outcome = await new Promise<string>((resolve, reject) => {",
          "  worker.onmessage = (event) => resolve(String(event.data))",
          "  worker.onerror = (event) => reject(event.error ?? new Error(event.message))",
          "})",
          "await worker.terminate()",
          'process.stdout.write(`${outcome}\\n`)',
          "",
        ].join("\n"),
      )
      await Bun.write(
        workerEntrypoint,
        [
          "// ── Generated Pi OAuth Worker Probe ──────────────────────────────",
          "// Exercises Worker-owned provider auth without network or real credentials.",
          "// ─────────────────────────────────────────────────────────────────",
          `import { createPiModels } from ${JSON.stringify(modelsPath)}`,
          `import { InMemoryCredentialStore } from ${JSON.stringify(piPath)}`,
          "",
          "const credentials = new InMemoryCredentialStore()",
          "await credentials.modify(\"openai-codex\", async () => ({",
          '  type: "oauth",',
          '  refresh: "probe-refresh",',
          '  access: "probe-access",',
          "  expires: Date.now() + 60_000,",
          "}))",
          "const registry = createPiModels({",
          '  main_provider: "openai-codex",',
          "  providers: {",
          '    "openai-codex": {',
          '      adapter: "openai-codex",',
          '      model: "gpt-5.6-sol",',
          '      auth: { type: "subscription" },',
          "    },",
          "  },",
          "}, credentials)",
          'const model = registry.model("openai-codex")',
          "const resolved = await registry.models.getAuth(model)",
          'if (resolved?.auth.apiKey !== "probe-access") throw new Error("OpenAI Codex OAuth did not resolve")',
          'postMessage("oauth-ready")',
          "",
        ].join("\n"),
      )

      const build = await Bun.build({
        entrypoints: [entrypoint, workerEntrypoint],
        conditions: ["browser"],
        define: {
          OAUTH_WORKER_PATH: JSON.stringify("./oauth-worker.ts"),
        },
        format: "esm",
        minify: true,
        splitting: true,
        compile: {
          autoloadBunfig: false,
          autoloadDotenv: false,
          autoloadTsconfig: false,
          autoloadPackageJson: false,
          outfile,
        },
      })
      expect(build.logs.map(String)).toEqual([])
      expect(build.success).toBe(true)

      const probe = Bun.spawn([outfile], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
        maxBuffer: 1_048_576,
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(probe.stdout).text(),
        new Response(probe.stderr).text(),
        probe.exited,
      ])

      expect({ exitCode, stderr: stderr.trim(), stdout: stdout.trim() }).toEqual({
        exitCode: 0,
        stderr: "",
        stdout: "oauth-ready",
      })
    },
    120_000,
  )
})
