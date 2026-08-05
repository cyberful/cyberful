// ── Manual Browser Profile Launcher Tests ───────────────────────────
// Verifies that the installed-command path selects one isolated identity and
// waits for its real child process without downloading or opening Chromium.
// → cyberful/src/dependency/browser-profile-launcher.ts — owns the tested child.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────────

import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { BrowserProfileLauncher } from "./browser-profile-launcher"

const ENVIRONMENT_KEYS = [
  "CYBERFUL_SKIP_BROWSER_PREFLIGHT",
  "CYBER_BROWSER_MCP_COMMAND",
  "CYBER_BROWSER_MCP_ENTRY",
  "CYBER_BROWSER_BUN_REENTRY",
  "CYBER_BROWSER_USER_DATA_DIR_3",
  "CYBER_BROWSER_ARTIFACTS_DIR_3",
  "CYBERFUL_TEST_BROWSER_RESULT",
] as const
const originalEnvironment = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]))
const temporaryRoots: string[] = []

afterEach(() => {
  ENVIRONMENT_KEYS.forEach((key) => {
    const value = originalEnvironment[key]
    if (value === undefined) delete process.env[key]
    if (value !== undefined) process.env[key] = value
  })
  temporaryRoots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
})

test("the installed CLI opens the selected persistent browser identity and waits for exit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-browser-profile-"))
  temporaryRoots.push(root)
  const fixture = path.join(root, "browser-fixture.ts")
  const result = path.join(root, "result.json")
  await Bun.write(
    fixture,
    `await Bun.write(process.env.CYBERFUL_TEST_BROWSER_RESULT, JSON.stringify({
      profile: process.env.CYBER_BROWSER_PROFILE_ID,
      profileDirectory: process.env.CYBER_BROWSER_USER_DATA_DIR,
      artifactsDirectory: process.env.CYBER_BROWSER_ARTIFACTS_DIR,
      eager: process.env.CYBER_BROWSER_EAGER,
      headless: process.env.CYBER_BROWSER_HEADLESS,
      bunReentry: process.env.BUN_BE_BUN,
    }))\n`,
  )
  Object.assign(process.env, {
    CYBERFUL_SKIP_BROWSER_PREFLIGHT: "1",
    CYBER_BROWSER_MCP_COMMAND: process.execPath,
    CYBER_BROWSER_MCP_ENTRY: fixture,
    CYBER_BROWSER_BUN_REENTRY: "1",
    CYBER_BROWSER_USER_DATA_DIR_3: "/profiles/three",
    CYBER_BROWSER_ARTIFACTS_DIR_3: "/artifacts/three",
    CYBERFUL_TEST_BROWSER_RESULT: result,
  })

  expect(await BrowserProfileLauncher.launchBrowserProfile(3, { write: () => {} })).toBe(0)
  expect(await Bun.file(result).json()).toEqual({
    profile: "3",
    profileDirectory: "/profiles/three",
    artifactsDirectory: "/artifacts/three",
    eager: "1",
    headless: "false",
    bunReentry: "1",
  })
})

test.skipIf(process.platform === "win32")(
  "terminal termination reaches the browser and waits for clean exit",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-browser-signal-"))
    temporaryRoots.push(root)
    const browserFixture = path.join(root, "browser-fixture.ts")
    const launcherFixture = path.join(root, "launcher-fixture.ts")
    const ready = path.join(root, "ready")
    const received = path.join(root, "received")
    await Promise.all([
      Bun.write(
        browserFixture,
        `await Bun.write(process.env.CYBERFUL_TEST_BROWSER_READY, "ready")
process.once("SIGTERM", async () => {
  await Bun.write(process.env.CYBERFUL_TEST_BROWSER_SIGNAL, "SIGTERM")
  process.exit(0)
})
await new Promise(() => {})
`,
      ),
      Bun.write(
        launcherFixture,
        `import { launchBrowserProfile } from ${JSON.stringify(
          pathToFileURL(path.join(import.meta.dir, "browser-profile-launcher.ts")).href,
        )}
process.exitCode = await launchBrowserProfile(4, { write: () => {} })
`,
      ),
    ])
    const parent = Bun.spawn([process.execPath, launcherFixture], {
      env: {
        ...process.env,
        CYBERFUL_SKIP_BROWSER_PREFLIGHT: "1",
        CYBER_BROWSER_MCP_COMMAND: process.execPath,
        CYBER_BROWSER_MCP_ENTRY: browserFixture,
        CYBER_BROWSER_BUN_REENTRY: "1",
        CYBER_BROWSER_USER_DATA_DIR_4: path.join(root, "profile"),
        CYBER_BROWSER_ARTIFACTS_DIR_4: path.join(root, "artifacts"),
        CYBERFUL_TEST_BROWSER_READY: ready,
        CYBERFUL_TEST_BROWSER_SIGNAL: received,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })

    try {
      const deadline = Date.now() + 5_000
      while (!fs.existsSync(ready)) {
        if (Date.now() >= deadline) throw new Error("browser fixture did not become ready")
        await Bun.sleep(10)
      }
      parent.kill("SIGTERM")
      const exitCode = await Promise.race([
        parent.exited,
        Bun.sleep(5_000).then(() => {
          throw new Error("browser launcher did not reap its terminated child")
        }),
      ])
      expect(exitCode).toBe(0)
      expect(await Bun.file(received).text()).toBe("SIGTERM")
    } finally {
      if (parent.exitCode === null) parent.kill("SIGKILL")
      await parent.exited
    }
  },
)
