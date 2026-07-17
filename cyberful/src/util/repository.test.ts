// ── Repository Reference Boundary Tests ─────────────────────────
// Protects normal shorthand parsing while rejecting protocols and branch names
// that must never reach Git or the shared repository cache.
// → cyberful/src/util/repository.ts — implements the validation under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import {
  InvalidRepositoryBranchError,
  InvalidRepositoryReferenceError,
  parseRemoteRepositoryReference,
  validateRepositoryBranch,
} from "./repository"

describe("repository reference boundary", () => {
  test("normalizes the GitHub shorthand users put in project config", () => {
    expect(parseRemoteRepositoryReference("cyberful-dev/cyberful")).toMatchObject({
      host: "github.com",
      owner: "cyberful-dev",
      repo: "cyberful",
      remote: "https://github.com/cyberful-dev/cyberful.git",
    })
  })

  test("rejects unsupported URL protocols before invoking Git", () => {
    expect(() => parseRemoteRepositoryReference("ftp://example.com/owner/repo.git")).toThrow(
      InvalidRepositoryReferenceError,
    )
  })

  test("accepts ordinary feature branches and rejects ambiguous Git refs", () => {
    expect(() => validateRepositoryBranch("feature/session-report")).not.toThrow()
    for (const branch of ["-force", "/root", "root/", "feature//report", "release..next", "topic.lock"]) {
      expect(() => validateRepositoryBranch(branch)).toThrow(InvalidRepositoryBranchError)
    }
  })
})
