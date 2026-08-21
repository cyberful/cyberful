// ── Browser Preflight Boundary Tests ────────────────────────────
// Verifies the pinned runtime version, strict skip policy, timeout reaping, and
//   output limits using local children instead of downloading a browser.
// → cyberful/src/dependency/browser-preflight.ts — owns provisioning policy.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { installChromium, shouldSkipBrowserPreflight } from "./browser-preflight"

describe("browser preflight boundary", () => {
  test("accepts explicit boolean spellings and rejects malformed policy", () => {
    expect(shouldSkipBrowserPreflight({ CYBERFUL_SKIP_BROWSER_PREFLIGHT: "yes" })).toBe(true)
    expect(shouldSkipBrowserPreflight({ CYBERFUL_SKIP_BROWSER_PREFLIGHT: "false" })).toBe(false)
    expect(() => shouldSkipBrowserPreflight({ CYBERFUL_SKIP_BROWSER_PREFLIGHT: "sometimes" })).toThrow("must be one of")
  })

  test("accepts the pinned agent-browser fork before checking its plugin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-browser-preflight-"))
    const browser = path.join(root, "agent-browser")
    const captcha = path.join(root, "agent-browser-plugin-captcha")
    try {
      await Promise.all([
        Bun.write(browser, "#!/bin/sh\nprintf 'agent-browser 0.34.0-cyberful.3\\n'\n"),
        Bun.write(captcha, "#!/bin/sh\nprintf 'unsupported CAPTCHA plugin\\n'\n"),
      ])
      await Promise.all([chmod(browser, 0o755), chmod(captcha, 0o755)])

      const module = pathToFileURL(path.join(import.meta.dir, "browser-preflight.ts")).href
      const child = Bun.spawn(
        [process.execPath, "-e", `import { runBrowserPreflight } from ${JSON.stringify(module)}; await runBrowserPreflight()`],
        {
          env: {
            ...process.env,
            CYBERFUL_SKIP_BROWSER_PREFLIGHT: "0",
            CYBER_AGENT_BROWSER_BINARY: browser,
            CYBER_BROWSER_CAPTCHA_PLUGIN_COMMAND: captcha,
            NO_COLOR: "1",
          },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        },
      )
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])

      expect(code).toBe(0)
      expect(stderr).toContain("first-party agent-browser CAPTCHA plugin 0.1.0 is unavailable")
      expect(stderr).not.toContain("agent-browser 0.34.0-cyberful.3 is unavailable")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("times out and reaps a silent Chromium installer", async () => {
    await expect(
      installChromium([process.execPath, "-e", "setInterval(() => {}, 1_000)"], process.env, {
        timeoutMs: 25,
      }),
    ).rejects.toThrow("Chromium install timed out after 25ms")
  })

  test("terminates an installer that exceeds its output budget", async () => {
    await expect(
      installChromium([process.execPath, "-e", 'process.stdout.write("x".repeat(4096))'], process.env, {
        maxOutputBytes: 128,
      }),
    ).rejects.toThrow("Could not execute Chromium installer")
  })
})
