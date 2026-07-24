// ── Host-Owned Ghidra Store Tests ────────────────────────────────
// Verifies stable project identity, restrictive directories, and rejection of
// model-writable or symlinked storage roots.
// → cyberful/src/ghidra-store.ts — owns the tested persistent store.
// @docs/runtimes/ghidra.md
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { HostGhidraStore } from "./ghidra-store"

describe("host-owned Ghidra store", () => {
  test("reopens one protected store for the same canonical workarea", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "cyberful-ghidra-store-"))
    try {
      const workarea = path.join(base, "workarea")
      const data = path.join(base, "data")
      await Promise.all([mkdir(workarea), mkdir(data)])
      const first = await HostGhidraStore.ensureGhidraStore(workarea, data)
      const second = await HostGhidraStore.ensureGhidraStore(workarea, data)
      expect(second).toEqual(first)
      expect(first.root.startsWith(workarea)).toBe(false)
      if (process.platform !== "win32") expect((await lstat(first.root)).mode & 0o777).toBe(0o700)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test("rejects a store below the model workarea and symlinked store components", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "cyberful-ghidra-store-"))
    try {
      const workarea = path.join(base, "workarea")
      await mkdir(workarea)
      await expect(HostGhidraStore.ensureGhidraStore(workarea, workarea)).rejects.toThrow("physically separate")

      const data = path.join(base, "data")
      const target = path.join(base, "target")
      await Promise.all([mkdir(data), mkdir(target)])
      await symlink(target, path.join(data, "ghidra-store"))
      await expect(HostGhidraStore.ensureGhidraStore(workarea, data)).rejects.toThrow("non-directory or symlink")
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
