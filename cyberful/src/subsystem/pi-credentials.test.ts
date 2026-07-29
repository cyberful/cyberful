// ── Pi Credential Store Tests ────────────────────────────────────
// Verifies provider credentials stay in Cyberful-owned regular files with
// owner-only permissions and Pi-compatible serialized update semantics.
// → cyberful/src/subsystem/pi-credentials.ts — owns persistent credentials.
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { PiCredentialStore } from "./pi-credentials"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryStore() {
  const root = await mkdtemp(path.join(tmpdir(), "cyberful-pi-credentials-"))
  roots.push(root)
  const directory = path.join(root, "state")
  const file = path.join(directory, "pi-credentials.json")
  return { root, directory, file, store: new PiCredentialStore(file) }
}

describe("Pi credential store", () => {
  test("persists OAuth material atomically in owner-only storage", async () => {
    const harness = await temporaryStore()
    const credential = {
      type: "oauth" as const,
      access: "test-access-material",
      refresh: "test-refresh-material",
      expires: Date.now() + 60_000,
    }

    expect(await harness.store.modify("openai-codex", async () => credential)).toEqual(credential)
    expect(await harness.store.read("openai-codex")).toEqual(credential)
    expect(await harness.store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }])
    expect(JSON.parse(await readFile(harness.file, "utf8"))).toEqual({ "openai-codex": credential })

    if (process.platform !== "win32") {
      expect((await lstat(harness.directory)).mode & 0o777).toBe(0o700)
      expect((await lstat(harness.file)).mode & 0o777).toBe(0o600)
    }

    await harness.store.delete("openai-codex")
    expect(await harness.store.read("openai-codex")).toBeUndefined()
  })

  test("repairs an existing regular credential file that is readable by other users", async () => {
    const harness = await temporaryStore()
    await mkdir(harness.directory, { recursive: true })
    await writeFile(harness.file, "{}\n", { mode: 0o644 })

    expect(await harness.store.list()).toEqual([])
    if (process.platform !== "win32") expect((await lstat(harness.file)).mode & 0o777).toBe(0o600)
  })

  test("serializes updates for different providers without losing either credential", async () => {
    const harness = await temporaryStore()
    await Promise.all([
      harness.store.modify("main", async () => ({
        type: "api_key",
        key: "main-test-key",
      })),
      harness.store.modify("fallback", async () => ({
        type: "api_key",
        key: "fallback-test-key",
      })),
    ])

    expect(await harness.store.list()).toEqual([
      { providerId: "fallback", type: "api_key" },
      { providerId: "main", type: "api_key" },
    ])
  })

  test("refuses a symbolic-link credential target", async () => {
    const harness = await temporaryStore()
    const outside = path.join(harness.root, "outside.json")
    await mkdir(harness.directory, { recursive: true })
    await writeFile(outside, "{}\n")
    await symlink(outside, harness.file)

    await expect(harness.store.read("openai-codex")).rejects.toThrow(
      "Pi credential storage must be a regular file",
    )
  })
})
