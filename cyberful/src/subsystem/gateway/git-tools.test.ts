// ── Code Audit Diff Boundary Tests ──────────────────────────────
// Verifies offline Git hardening and immutable diff artifacts without touching
// the user's checkout.
// → cyberful/src/subsystem/gateway/git-tools.ts — owns the tested boundary.
// ────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { GIT_TOOL_DEFS, handleGitTool, offlineGitEnvironment } from "./git-tools"

const roots: string[] = []
const savedEnvironment = { ...process.env }

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-audit-diff-"))
  roots.push(root)
  const source = path.join(root, "source")
  const workarea = path.join(root, "workarea")
  const sourceStore = path.join(root, "source-store")
  await mkdir(source)
  await mkdir(workarea)
  await mkdir(path.join(sourceStore, "import"), { recursive: true })
  await git(source, "init", "-b", "main")
  await git(source, "config", "user.name", "Cyberful Test")
  await git(source, "config", "user.email", "cyberful@localhost")
  await writeFile(path.join(source, "app.ts"), "export const value = 1\n")
  await git(source, "add", "app.ts")
  await git(source, "commit", "-m", "base")
  process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT = source
  process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = workarea
  process.env.CYBERFUL_SOURCE_STORE_ROOT = sourceStore
  return { source, workarea }
}

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key]
  Object.assign(process.env, savedEnvironment)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Code Audit diff tools", () => {
  test("publishes one offline read-only tool", () => {
    expect(GIT_TOOL_DEFS.map((tool) => tool.name)).toEqual(["audit_diff_prepare"])
    const environment = offlineGitEnvironment({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      HTTPS_PROXY: "https://proxy.example",
      GIT_CONFIG_COUNT: "1",
      GIT_ASKPASS: "/tmp/askpass",
      CYBERFUL_CODE_GRAPH_LEDGER_KEY: "secret",
    })
    expect(environment.PATH).toBe("/usr/bin")
    expect(environment.HOME).toBe("/tmp/home")
    expect(environment.HTTPS_PROXY).toBeUndefined()
    expect(environment.GIT_CONFIG_COUNT).toBeUndefined()
    expect(environment.GIT_ASKPASS).toBeUndefined()
    expect(environment.CYBERFUL_CODE_GRAPH_LEDGER_KEY).toBeUndefined()
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0")
    expect(environment.GIT_ALLOW_PROTOCOL).toBe("")
  })

  test("seals committed, unstaged, and untracked changes under Code Audit evidence", async () => {
    const { source, workarea } = await fixture()
    await writeFile(path.join(source, "app.ts"), "export const value = dangerous(input)\n")
    await writeFile(path.join(source, "new.ts"), "export const input = userControlled()\n")

    const result = await handleGitTool("session", "audit_diff_prepare", {})
    expect(result.status).toBe("ready")
    expect(result.changed_files).toEqual(["app.ts", "new.ts"])
    expect(result.includes_working_tree).toBe(true)
    expect(result.patch_path).toBe("raw/code-audit/diff/changes.patch")
    expect(result.manifest_path).toBe("raw/code-audit/diff/manifest.json")
    expect(await readFile(path.join(workarea, result.patch_path), "utf8")).toContain("dangerous(input)")
    const manifest = JSON.parse(await readFile(path.join(workarea, result.manifest_path), "utf8"))
    expect(manifest.patch_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.patch_truncated).toBe(false)
    expect(await readFile(path.join(source, "app.ts"), "utf8")).toBe("export const value = dangerous(input)\n")
  })

  test("an explicit commit range excludes working-tree overlays", async () => {
    const { source } = await fixture()
    const base = await git(source, "rev-parse", "HEAD")
    await writeFile(path.join(source, "app.ts"), "export const value = 2\n")
    await git(source, "add", "app.ts")
    await git(source, "commit", "-m", "change")
    const head = await git(source, "rev-parse", "HEAD")
    await writeFile(path.join(source, "ignored.ts"), "working tree only\n")

    const result = await handleGitTool("session", "audit_diff_prepare", {
      base_ref: base,
      head_ref: head,
    })
    expect(result.includes_working_tree).toBe(false)
    expect(result.changed_files).toEqual(["app.ts"])
    expect(result.untracked).toEqual([])
  })
})
