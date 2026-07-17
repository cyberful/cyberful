// ── Release Planning Contract ───────────────────────────────────────
// Exercises version inference, distributable-file classification, forced
// releases, and safe resumption as CI users encounter those workflows.
// → scripts/release-plan.ts — computes and serializes the release decision.
// ────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  isConventionalTitle,
  isReleaseFile,
  planRelease,
  planRepositoryRelease,
  resumeRelease,
  type ReleaseCommit,
} from "../../scripts/release-plan"

const temporaryRoots: string[] = []

afterEach(() => {
  temporaryRoots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
})

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
    timeout: 30_000,
    maxBuffer: 1_048_576,
  })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim())
}

const commit = (subject: string, files = ["cyberful/src/index.ts"], body = ""): ReleaseCommit => ({
  subject,
  body,
  files,
})

describe("release planner", () => {
  test("starts public releases at 0.1.0", () => {
    expect(planRelease({ head: "head", commits: [commit("feat: first release")] })).toMatchObject({
      release: true,
      version: "0.1.0",
      bump: "minor",
    })
  })

  test("uses the highest automatic bump", () => {
    expect(
      planRelease({
        head: "head",
        previousTag: "v1.2.3",
        commits: [commit("fix: patch"), commit("feat: feature"), commit("fix!: contract")],
      }),
    ).toMatchObject({ version: "2.0.0", bump: "major", relevantCommits: 3 })
  })

  test("recognizes breaking change footers", () => {
    expect(
      planRelease({
        head: "head",
        previousTag: "v1.2.3",
        commits: [commit("refactor: gateway", undefined, "BREAKING CHANGE: config changed")],
      }),
    ).toMatchObject({ version: "2.0.0", bump: "major" })
  })

  test("does not release documentation, tests, or CI alone", () => {
    expect(
      planRelease({
        head: "head",
        previousTag: "v1.2.3",
        commits: [commit("docs: explain", ["docs/index.md"]), commit("test: cover", ["cyberful/src/a.test.ts"])],
      }),
    ).toEqual({ release: false, previousTag: "v1.2.3", head: "head", relevantCommits: 0, resume: false })
  })

  test("requires a reason when forcing without changes", () => {
    expect(() => planRelease({ head: "head", previousTag: "v1.2.3", commits: [], forceWithoutChanges: true })).toThrow(
      "reason is required",
    )
    expect(
      planRelease({
        head: "head",
        previousTag: "v1.2.3",
        commits: [],
        forceWithoutChanges: true,
        reason: "Rebuild publication metadata",
      }),
    ).toMatchObject({ version: "1.2.4", bump: "patch" })
  })

  test("manual bumps can raise but not lower automatic impact", () => {
    expect(
      planRelease({
        head: "head",
        previousTag: "v1.2.3",
        commits: [commit("fix: patch")],
        requestedBump: "minor",
      }),
    ).toMatchObject({ version: "1.3.0", bump: "minor" })
    expect(() =>
      planRelease({
        head: "head",
        previousTag: "v1.2.3",
        commits: [commit("feat!: break")],
        requestedBump: "patch",
      }),
    ).toThrow("cannot lower")
  })

  test("resumes the tagged version and original commit", () => {
    expect(resumeRelease({ tag: "v1.4.2", head: "tagged-head", previousTag: "v1.4.1", relevantCommits: 2 })).toEqual({
      release: true,
      version: "1.4.2",
      head: "tagged-head",
      previousTag: "v1.4.1",
      relevantCommits: 2,
      resume: true,
    })
  })

  test("plans from the explicitly selected repository and canonicalizes HEAD", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-release-plan-"))
    temporaryRoots.push(root)
    fs.mkdirSync(path.join(root, "cyberful/src"), { recursive: true })
    fs.writeFileSync(path.join(root, "cyberful/src/index.ts"), "export const release = true\n")
    git(root, ["init", "-q"])
    git(root, ["add", "."])
    git(root, [
      "-c",
      "user.name=Cyberful Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-qm",
      "feat: first release",
    ])

    expect(planRepositoryRelease({ repositoryRoot: root, head: "HEAD" })).toMatchObject({
      release: true,
      version: "0.1.0",
      bump: "minor",
      head: expect.stringMatching(/^[0-9a-f]{40}$/),
    })
  })
})

describe("release policy classification", () => {
  test("classifies shipped and non-shipped paths", () => {
    expect(isReleaseFile("cyberful/builtin/agents/pentest/brief.md")).toBe(true)
    expect(isReleaseFile("cyberful/builtin/agents/ask/ask.md")).toBe(true)
    expect(isReleaseFile("cyberful/bin/cyberful")).toBe(true)
    expect(isReleaseFile("mcps/zap/Dockerfile")).toBe(true)
    expect(isReleaseFile("bun.lock")).toBe(true)
    expect(isReleaseFile("LICENSE")).toBe(true)
    expect(isReleaseFile("THIRD_PARTY_NOTICES.md")).toBe(true)
    expect(isReleaseFile("docs/overview/testing.md")).toBe(false)
    expect(isReleaseFile("mcps/cyberful-os/tests/test_catalog.py")).toBe(false)
  })

  test("validates conventional PR titles", () => {
    expect(isConventionalTitle("feat(cli): publish packages")).toBe(true)
    expect(isConventionalTitle("fix!: change release contract")).toBe(true)
    expect(isConventionalTitle("publish packages")).toBe(false)
  })
})
