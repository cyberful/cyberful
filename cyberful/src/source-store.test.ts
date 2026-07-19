// ── Host-Owned Source Store Tests ────────────────────────────────
// Proves durable per-workarea keys, isolation between workareas, and physical
// separation from the model-writable tree.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { ensureSourceStore } from "./source-store"

describe("host-owned source store", () => {
  test("keeps one durable key across concurrent starts and session resumption", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-source-store-"))
    try {
      const data = path.join(root, "data")
      const firstWorkarea = path.join(root, "workarea-a")
      const secondWorkarea = path.join(root, "workarea-b")
      await Promise.all([mkdir(data), mkdir(firstWorkarea), mkdir(secondWorkarea)])

      const concurrent = await Promise.all(Array.from({ length: 16 }, () => ensureSourceStore(firstWorkarea, data)))
      const first = concurrent[0]
      if (!first) throw new Error("concurrent source-store setup returned no result")
      const resumed = await ensureSourceStore(firstWorkarea, data)
      const second = await ensureSourceStore(secondWorkarea, data)

      expect(concurrent.every((store) => store.attestationKey === first.attestationKey)).toBe(true)
      expect(resumed).toEqual(first)
      expect(second.attestationKey).not.toBe(first.attestationKey)
      expect(path.relative(firstWorkarea, first.root).startsWith(".." + path.sep)).toBe(true)
      expect(first.attestationKey).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a store nested inside the writable workarea", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-source-store-nested-"))
    try {
      const data = path.join(root, "data")
      await mkdir(data)
      await expect(ensureSourceStore(root, data)).rejects.toThrow("physically separate")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
