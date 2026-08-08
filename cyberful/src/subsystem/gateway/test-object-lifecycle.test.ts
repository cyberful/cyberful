// ── Test Object Lifecycle Ledger Tests ──────────────────────────
// Verifies ordered cleanup transitions, terminal residue, and handoff rejection
// when a synthetic target object is left in an unknown intermediate state.
// → cyberful/src/subsystem/gateway/test-object-lifecycle.ts — owns the ledger.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { TestObjectLifecycleLedger } from "./test-object-lifecycle"

describe("test object lifecycle ledger", () => {
  test("requires cleanup or explicit residue before handoff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-test-object-"))
    try {
      const ledger = new TestObjectLifecycleLedger(root, "exploit")
      await ledger.transition({ action: "transition", id: "dataset-1", kind: "dataset", label: "B4 fixture", state: "planned" })
      await ledger.transition({ action: "transition", id: "dataset-1", state: "created" })
      expect(await ledger.handoffError()).toContain("dataset-1 (created)")
      await ledger.transition({ action: "transition", id: "dataset-1", state: "oracle_checked" })
      await ledger.transition({ action: "transition", id: "dataset-1", state: "cleanup_attempted" })
      await mkdir(path.join(root, "raw"), { recursive: true })
      await writeFile(path.join(root, "raw", "dataset-cleanup.md"), "cleanup evidence\n")
      await ledger.transition({ action: "transition", id: "dataset-1", state: "cleaned", evidence_path: "raw/dataset-cleanup.md" })
      expect(await ledger.handoffError()).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("keeps residual terminal and rejects skipped transitions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-test-object-"))
    try {
      const ledger = new TestObjectLifecycleLedger(root, "hacker")
      await expect(ledger.transition({ action: "transition", id: "event-1", state: "created" })).rejects.toThrow(
        "begin in planned",
      )
      await ledger.transition({ action: "transition", id: "event-1", kind: "event", label: "unique event", state: "planned" })
      await ledger.transition({ action: "transition", id: "event-1", state: "created" })
      await ledger.transition({
        action: "transition",
        id: "event-1",
        state: "residual",
        residual_reason: "The product exposes no per-event deletion.",
      })
      expect(await ledger.handoffError()).toBeUndefined()
      await expect(ledger.transition({ action: "transition", id: "event-1", state: "cleaned" })).rejects.toThrow(
        "cannot transition",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("closes a planned object that was never created", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-test-object-"))
    try {
      const ledger = new TestObjectLifecycleLedger(root, "recon")
      await ledger.transition({
        action: "transition",
        id: "project-1",
        kind: "project",
        label: "planned fixture",
        state: "planned",
      })
      await ledger.transition({ action: "transition", id: "project-1", state: "not_created" })
      expect(await ledger.handoffError()).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("recovers only one child's objects and reports missing referenced evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-test-object-"))
    try {
      const ledger = new TestObjectLifecycleLedger(root, "exploit")
      const child = { runID: "child-7", displayName: "api-monster", kind: "subagent" }
      const parent = { runID: "root-1", displayName: "root", kind: "root" }
      await ledger.transition({
        action: "transition",
        id: "child-record",
        kind: "record",
        label: "child fixture",
        state: "planned",
        _cyberful_actor: child,
      })
      await ledger.transition({ action: "transition", id: "child-record", state: "created" })
      await ledger.transition({ action: "transition", id: "child-record", state: "cleanup_attempted" })
      await ledger.transition({
        action: "transition",
        id: "child-record",
        state: "cleaned",
        evidence_path: "raw/evidence/child-cleanup.json",
      })
      await ledger.transition({
        action: "transition",
        id: "root-record",
        kind: "record",
        label: "root fixture",
        state: "planned",
        _cyberful_actor: parent,
      })
      await ledger.transition({ action: "transition", id: "root-record", state: "not_created" })

      expect(await ledger.recover("child-7")).toEqual([
        expect.objectContaining({
          id: "child-record",
          actorRunID: "child-7",
          actorRole: "subagent",
          evidencePath: "raw/evidence/child-cleanup.json",
          evidenceExists: false,
        }),
      ])
      expect(await ledger.handoffError()).toBe(
        "test object lifecycle references missing evidence: child-record (raw/evidence/child-cleanup.json)",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
