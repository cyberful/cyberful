// ── Explicit Public Source Import Tests ─────────────────────────────────────
// Verifies URL/ref policy, human denial, public-address enforcement, and a
// deterministic hook-free import using an injected Git boundary.
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import {
  attestSourceImportManifest,
  handleSourceImport,
  parseSourceImportRequest,
  publicNetworkAddress,
  sourceImportGitEnvironment,
  type SourceImportManifestPayload,
  verifySourceImport,
} from "./source-import"
import { effectiveSourceRoot } from "./source-tools"
import { isRecord } from "@/util/record"

let root = ""
let workarea = ""
let sourceStore = ""
let importRoot = ""
let previousWorkarea: string | undefined
let previousWorkflow: string | undefined
let previousSourceStore: string | undefined
let previousImportKey: string | undefined

const importKey = "source-import-test-attestation-key-with-at-least-thirty-two-bytes"

function sourceEnvironment(extra: Record<string, string> = {}) {
  return {
    CYBERFUL_SOURCE_STORE_ROOT: sourceStore,
    CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY: importKey,
    ...extra,
  }
}

function cloneDestination(args: readonly string[]): string {
  const destination = args.at(-1)
  if (!destination) throw new Error("source-import fixture received a clone command without a destination")
  return destination
}

async function runLocalGit(args: readonly string[], cwd: string) {
  const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr, truncated: false }
}

async function fixtureImportGit(args: readonly string[], cwd: string) {
  if (args.includes("clone")) {
    const destination = cloneDestination(args)
    const initialized = await runLocalGit(["init", "--quiet", destination], cwd)
    if (initialized.exitCode !== 0) return initialized
    await writeFile(path.join(destination, "main.ts"), "export const sealed = true\n")
    const added = await runLocalGit(["add", "--", "main.ts"], destination)
    if (added.exitCode !== 0) return added
    return runLocalGit(
      ["-c", "user.name=Cyberful Tests", "-c", "user.email=cyberful@localhost", "commit", "--quiet", "-m", "fixture"],
      destination,
    )
  }
  return runLocalGit(args, cwd)
}

async function createRealImport() {
  return handleSourceImport(
    { url: "https://github.com/example/project.git" },
    {
      confirm: async () => true,
      resolveHost: async () => ["8.8.8.8"],
      runGit: fixtureImportGit,
    },
  )
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cyberful-source-import-"))
  workarea = path.join(root, "workarea")
  sourceStore = path.join(root, "source-store")
  importRoot = path.join(sourceStore, "import")
  await Promise.all([mkdir(workarea), mkdir(importRoot, { recursive: true })])
  previousWorkarea = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT
  previousWorkflow = process.env.CYBERFUL_SUBSYSTEM_WORKFLOW
  previousSourceStore = process.env.CYBERFUL_SOURCE_STORE_ROOT
  previousImportKey = process.env.CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY
  process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = workarea
  process.env.CYBERFUL_SOURCE_STORE_ROOT = sourceStore
  process.env.CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY = importKey
  delete process.env.CYBERFUL_SUBSYSTEM_WORKFLOW
})

afterEach(async () => {
  if (previousWorkarea === undefined) delete process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT
  else process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = previousWorkarea
  if (previousWorkflow === undefined) delete process.env.CYBERFUL_SUBSYSTEM_WORKFLOW
  else process.env.CYBERFUL_SUBSYSTEM_WORKFLOW = previousWorkflow
  if (previousSourceStore === undefined) delete process.env.CYBERFUL_SOURCE_STORE_ROOT
  else process.env.CYBERFUL_SOURCE_STORE_ROOT = previousSourceStore
  if (previousImportKey === undefined) delete process.env.CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY
  else process.env.CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY = previousImportKey
  await rm(root, { recursive: true, force: true })
})

describe("public source import policy", () => {
  test("accepts only credential-free HTTPS and safe explicit refs", () => {
    expect(
      parseSourceImportRequest({
        url: "https://github.com/example/project.git",
        checkout_ref: "refs/pull/42/head",
        additional_refs: ["main", "release/v2"],
      }),
    ).toMatchObject({ host: "github.com", checkoutRef: "refs/pull/42/head" })
    expect(() => parseSourceImportRequest({ url: "ssh://git@github.com/example/project" })).toThrow("HTTPS")
    expect(() => parseSourceImportRequest({ url: "https://token@github.com/example/project" })).toThrow(
      "credential-free",
    )
    expect(() => parseSourceImportRequest({ url: "https://localhost/project" })).toThrow("public hostname")
    expect(() => parseSourceImportRequest({ url: "https://example.com/repo", checkout_ref: "main^{tree}" })).toThrow(
      "safe explicit Git ref",
    )
  })

  test("classifies private, loopback, documentation, and public addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.1.1",
      "192.168.1.1",
      "198.51.100.2",
      "203.0.113.4",
      "::1",
      "fd00::1",
      "2001:db8::1",
    ])
      expect(publicNetworkAddress(address)).toBe(false)
    expect(publicNetworkAddress("8.8.8.8")).toBe(true)
    expect(publicNetworkAddress("2606:4700:4700::1111")).toBe(true)
  })

  test("does not inherit proxies, credentials, injected Git config, or the user's home", () => {
    const env = sourceImportGitEnvironment(
      {
        PATH: "/safe/bin",
        LANG: "en_US.UTF-8",
        HTTPS_PROXY: "http://127.0.0.1:9000",
        ALL_PROXY: "socks5://127.0.0.1:9001",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: "Authorization: bearer secret",
        GIT_ASKPASS: "/tmp/steal",
        GCM_HTTP_TOKEN: "secret",
        GITHUB_TOKEN: "secret",
        HOME: "/home/user",
      },
      "/tmp/isolated-git-home",
    )
    expect(env).toMatchObject({
      PATH: "/safe/bin",
      LANG: "en_US.UTF-8",
      HOME: "/tmp/isolated-git-home",
      USERPROFILE: "/tmp/isolated-git-home",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
    })
    for (const key of [
      "HTTPS_PROXY",
      "ALL_PROXY",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_ASKPASS",
      "GCM_HTTP_TOKEN",
      "GITHUB_TOKEN",
    ])
      expect(key in env).toBe(false)
  })

  test("does not resolve or run Git when the human declines", async () => {
    let resolved = false
    let ran = false
    const result = await handleSourceImport(
      { url: "https://github.com/example/project.git" },
      {
        confirm: async () => false,
        resolveHost: async () => {
          resolved = true
          return ["8.8.8.8"]
        },
        runGit: async () => {
          ran = true
          return { exitCode: 0, stdout: "", stderr: "", truncated: false }
        },
      },
    )
    expect(result).toEqual({ imported: false, reason: "human-declined" })
    expect({ resolved, ran }).toEqual({ resolved: false, ran: false })
  })

  test("does not ask for approval when host attestation is unavailable", async () => {
    delete process.env.CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY
    let prompted = false
    await expect(
      handleSourceImport(
        { url: "https://github.com/example/project.git" },
        {
          confirm: async () => {
            prompted = true
            return true
          },
        },
      ),
    ).rejects.toThrow("attestation key is unavailable")
    expect(prompted).toBe(false)
  })

  test("seals resolved commits and ref mappings for later offline analysis", async () => {
    const calls: string[][] = []
    const result = await handleSourceImport(
      {
        url: "https://github.com/example/project.git",
        checkout_ref: "feature",
        additional_refs: ["main"],
      },
      {
        confirm: async () => true,
        resolveHost: async () => ["8.8.8.8"],
        now: () => new Date("2026-07-16T12:00:00.000Z"),
        runGit: async (args) => {
          calls.push([...args])
          if (args.includes("clone")) {
            const destination = cloneDestination(args)
            await mkdir(path.join(destination, ".git"), { recursive: true })
            await writeFile(path.join(destination, "main.ts"), "export const safe = true\n")
          }
          return {
            exitCode: 0,
            stdout: args[0] === "rev-parse" ? "a".repeat(40) + "\n" : "",
            stderr: "",
            truncated: false,
          }
        },
      },
    )
    expect(result).toMatchObject({
      imported: true,
      commit: "a".repeat(40),
      network_complete: true,
      submodules: false,
      lfs_smudge: false,
      local_refs: { checkout: "refs/cyberful/import-head", main: "refs/cyberful/import/0" },
    })
    expect(
      calls.map((args) =>
        args.find((item) => ["clone", "fetch", "update-ref", "checkout", "rev-parse"].includes(item)),
      ),
    ).toEqual([
      "clone",
      "fetch",
      "update-ref",
      "rev-parse",
      "fetch",
      "update-ref",
      "rev-parse",
      "checkout",
      "rev-parse",
    ])
    expect(calls[0]?.slice(0, 2)).toEqual(["-c", "http.curloptResolve=github.com:443:8.8.8.8"])
    const manifest: unknown = JSON.parse(
      await readFile(path.join(importRoot, "manifest.json"), "utf8"),
    )
    if (!isRecord(manifest)) throw new Error("source import fixture manifest is not an object")
    expect(manifest).toMatchObject({
      version: 2,
      url: "https://github.com/example/project.git",
      commit: "a".repeat(40),
      tree: { algorithm: "sha256", files: 1, excludes: [".git"] },
      attestation: { algorithm: "hmac-sha256" },
    })
    if (!isRecord(manifest.attestation)) throw new Error("source import fixture attestation is not an object")
    expect(manifest.attestation.hmac_sha256).toMatch(/^[a-f0-9]{64}$/)
    await expect(readFile(path.join(workarea, "raw", "source-import", "manifest.json"), "utf8")).rejects.toThrow()

    let promptedAgain = false
    await expect(
      handleSourceImport(
        { url: "https://github.com/example/other.git" },
        {
          confirm: async () => {
            promptedAgain = true
            return true
          },
        },
      ),
    ).rejects.toThrow("already exists")
    expect(promptedAgain).toBe(false)
  })

  test("rejects a hostname with any private resolution before Git runs", async () => {
    let ran = false
    await expect(
      handleSourceImport(
        { url: "https://example.com/project.git" },
        {
          confirm: async () => true,
          resolveHost: async () => ["93.184.216.34", "127.0.0.1"],
          runGit: async () => {
            ran = true
            return { exitCode: 0, stdout: "", stderr: "", truncated: false }
          },
        },
      ),
    ).rejects.toThrow("exclusively to public")
    expect(ran).toBe(false)
  })

  test("imports complete history for Secure Review merge-base analysis", async () => {
    process.env.CYBERFUL_SUBSYSTEM_WORKFLOW = "secure-review"
    const calls: string[][] = []
    const result = await handleSourceImport(
      {
        url: "https://github.com/example/project.git",
        checkout_ref: "feature",
        additional_refs: ["main"],
      },
      {
        confirm: async () => true,
        resolveHost: async () => ["8.8.8.8"],
        runGit: async (args) => {
          calls.push([...args])
          if (args.includes("clone")) {
            const destination = cloneDestination(args)
            await mkdir(path.join(destination, ".git"), { recursive: true })
            await writeFile(path.join(destination, "main.ts"), "export const safe = true\n")
          }
          return {
            exitCode: 0,
            stdout: args[0] === "rev-parse" ? "b".repeat(40) + "\n" : "",
            stderr: "",
            truncated: false,
          }
        },
      },
    )

    expect(result).toMatchObject({ imported: true, history_complete: true })
    for (const call of calls.filter((args) => args.includes("clone") || args.includes("fetch")))
      expect(call).not.toContain("--depth=1")
  })

  test("uses an attested import and fails closed when its source tree changes", async () => {
    await createRealImport()
    const repository = path.join(importRoot, "repository")
    expect(
      await effectiveSourceRoot(
        root,
        workarea,
        sourceEnvironment({ CYBERFUL_CODE_GRAPH_LEDGER_KEY: "a-different-session-ledger-key" }),
      ),
    ).toBe(
      await realpath(repository),
    )
    await writeFile(path.join(repository, "main.ts"), "export const sealed = false\n")
    await expect(effectiveSourceRoot(root, workarea, sourceEnvironment())).rejects.toThrow(
      "attested content",
    )
  })

  test("fails closed when the authenticated manifest or HEAD commit changes", async () => {
    await createRealImport()
    const manifestPath = path.join(importRoot, "manifest.json")
    const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"))
    if (!isRecord(manifest)) throw new Error("source import fixture manifest is not an object")
    manifest.created_at = "2099-01-01T00:00:00.000Z"
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
    await expect(effectiveSourceRoot(root, workarea, sourceEnvironment())).rejects.toThrow(
      "attestation does not match",
    )

    await Promise.all([
      rm(path.join(importRoot, "repository"), { recursive: true, force: true }),
      rm(path.join(importRoot, "manifest.json"), { force: true }),
    ])
    await createRealImport()
    const repository = path.join(importRoot, "repository")
    const committed = await runLocalGit(
      [
        "-c",
        "user.name=Cyberful Tests",
        "-c",
        "user.email=cyberful@localhost",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "tampered head",
      ],
      repository,
    )
    expect(committed.exitCode).toBe(0)
    await expect(effectiveSourceRoot(root, workarea, sourceEnvironment())).rejects.toThrow(
      "HEAD no longer matches",
    )
  })

  test("rejects authenticated manifests whose runtime fields are malformed", async () => {
    await createRealImport()
    const manifestPath = path.join(importRoot, "manifest.json")
    const repository = path.join(importRoot, "repository")
    const original = await verifySourceImport(repository, manifestPath, sourceEnvironment())
    const { attestation: _attestation, ...payload } = original
    const cases = [
      { field: "files_on_disk", value: "1", error: "manifest is malformed" },
      { field: "resolved_addresses", value: ["127.0.0.1"], error: "manifest is malformed" },
      { field: "created_at", value: "yesterday", error: "invalid creation time" },
    ] as const

    for (const malformedCase of cases) {
      const malformed = structuredClone(payload)
      Reflect.set(malformed, malformedCase.field, malformedCase.value)
      const sealed = attestSourceImportManifest(malformed, sourceEnvironment())
      await writeFile(manifestPath, JSON.stringify(sealed, null, 2) + "\n")
      await expect(effectiveSourceRoot(root, workarea, sourceEnvironment())).rejects.toThrow(
        malformedCase.error,
      )
    }
  })

  test("does not silently fall back when an import becomes incomplete", async () => {
    await createRealImport()
    await rm(path.join(importRoot, "manifest.json"))
    await expect(effectiveSourceRoot(root, workarea, sourceEnvironment())).rejects.toThrow(
      "manifest is missing",
    )
  })

  test("verifies every sealed local ref without network access", async () => {
    await createRealImport()
    const repository = path.join(importRoot, "repository")
    const manifestPath = path.join(importRoot, "manifest.json")
    const original = await verifySourceImport(repository, manifestPath, sourceEnvironment())
    const localRef = "refs/cyberful/import/0"
    expect((await runLocalGit(["update-ref", localRef, original.commit], repository)).exitCode).toBe(0)
    const { attestation: _attestation, ...unsigned } = original
    const payload: SourceImportManifestPayload = {
      ...unsigned,
      additional_refs: ["main"],
      local_refs: { main: localRef },
      sealed_refs: [{ requested_ref: "main", local_ref: localRef, commit: original.commit }],
    }
    await writeFile(
      manifestPath,
      JSON.stringify(attestSourceImportManifest(payload, sourceEnvironment()), null, 2) + "\n",
    )
    expect(await effectiveSourceRoot(root, workarea, sourceEnvironment())).toBe(
      await realpath(repository),
    )

    const originalHead = original.commit
    expect(
      (
        await runLocalGit(
          [
            "-c",
            "user.name=Cyberful Tests",
            "-c",
            "user.email=cyberful@localhost",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "alternate ref",
          ],
          repository,
        )
      ).exitCode,
    ).toBe(0)
    const alternate = (await runLocalGit(["rev-parse", "HEAD^{commit}"], repository)).stdout.trim()
    expect((await runLocalGit(["reset", "--hard", "--quiet", originalHead], repository)).exitCode).toBe(0)
    expect((await runLocalGit(["update-ref", localRef, alternate], repository)).exitCode).toBe(0)
    await expect(effectiveSourceRoot(root, workarea, sourceEnvironment())).rejects.toThrow(
      "ref 'refs/cyberful/import/0' no longer matches",
    )
  })
})
