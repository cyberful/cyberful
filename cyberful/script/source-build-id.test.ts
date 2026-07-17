// ── Source Build Identity Contract ──────────────────────────────────
// Proves source launches change identity for tracked and untracked TUI edits
// while ignored or unrelated repository files leave the identity stable.
// → cyberful/script/source-build-id.ts — derives the unbundled build identity.
// ────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { sourceBuildID } from "./source-build-id"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "ignore",
    stderr: "pipe",
    timeout: 30_000,
    maxBuffer: 1_048_576,
  })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), "cyberful-source-build-id-"))
  roots.push(root)
  await mkdir(path.join(root, "tui"))
  await Bun.write(path.join(root, ".gitignore"), "tui/ignored.txt\n")
  await Bun.write(path.join(root, "tui", "tracked.ts"), "export const value = 1\n")
  git(root, ["init", "-q"])
  git(root, ["add", "."])
  git(root, ["-c", "user.name=Cyberful Test", "-c", "user.email=test@localhost", "commit", "-qm", "base"])
  return root
}

describe("sourceBuildID", () => {
  test("is stable for one tree and changes for tracked, staged and untracked TUI content", async () => {
    const root = await repository()
    const clean = await sourceBuildID(root)
    expect(await sourceBuildID(root)).toBe(clean)

    await Bun.write(path.join(root, "tui", "tracked.ts"), "export const value = 2\n")
    const tracked = await sourceBuildID(root)
    expect(tracked).not.toBe(clean)
    git(root, ["add", "tui/tracked.ts"])
    expect(await sourceBuildID(root)).toBe(tracked)

    await Bun.write(path.join(root, "tui", "new.ts"), "export const added = true\n")
    expect(await sourceBuildID(root)).not.toBe(tracked)
  })

  test("ignores files outside TUI and ignored runtime files", async () => {
    const root = await repository()
    const clean = await sourceBuildID(root)
    await Bun.write(path.join(root, "outside.txt"), "not part of the TUI artifact\n")
    await Bun.write(path.join(root, "tui", "ignored.txt"), "runtime\n")
    expect(await sourceBuildID(root)).toBe(clean)
  })

  test("uses an explicit fallback outside a Git checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cyberful-source-no-git-"))
    roots.push(root)
    expect(await sourceBuildID(root)).toBe("source-unbundled")
  })
})
