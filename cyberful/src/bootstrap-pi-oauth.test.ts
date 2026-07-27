// ── Pi OAuth Standalone Bootstrap Contract ──────────────────────
// Compiles and executes the provider-auth boundary that release binaries use,
//   proving OpenAI Codex OAuth remains available without runtime package files.
// → cyberful/src/bootstrap-pi-oauth.ts — statically registers Pi OAuth flows.
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
      const outfile = path.join(root, process.platform === "win32" ? "oauth-probe.exe" : "oauth-probe")
      const bootstrapPath = path.join(import.meta.dir, "bootstrap-pi-oauth.ts")
      const providerPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/providers/openai-codex"))

      await Bun.write(
        entrypoint,
        [
          "// ── Generated Pi OAuth Standalone Probe ──────────────────────────",
          "// Exercises the compiled provider loader without network or credentials.",
          "// ─────────────────────────────────────────────────────────────────",
          `import ${JSON.stringify(bootstrapPath)}`,
          `import { openaiCodexProvider } from ${JSON.stringify(providerPath)}`,
          "",
          'const oauth = openaiCodexProvider().auth.oauth',
          'if (!oauth) throw new Error("OpenAI Codex OAuth is unavailable")',
          "const resolved = await oauth.toAuth({",
          '  type: "oauth",',
          '  refresh: "probe-refresh",',
          '  access: "probe-access",',
          "  expires: Date.now() + 60_000,",
          "})",
          'if (resolved.apiKey !== "probe-access") throw new Error("OpenAI Codex OAuth did not resolve")',
          'process.stdout.write("oauth-ready\\n")',
          "",
        ].join("\n"),
      )

      const build = await Bun.build({
        entrypoints: [entrypoint],
        conditions: ["browser"],
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
