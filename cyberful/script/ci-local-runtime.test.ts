// ── Local Runtime CI Boundary ───────────────────────────────────
// Keeps runtime image construction on the operator's Docker host and prevents
//   retired cloud runners or container-publication jobs from returning to CI.
// → .github/workflows/ci.yml — owns the pull-request and main validation path.
// → .github/workflows/release.yml — publishes native packages without a runtime image.
// @docs/development/testing.md
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import path from "node:path"

const repositoryRoot = path.resolve(import.meta.dir, "../..")

describe("local runtime CI boundary", () => {
  test("retired runtime publication and cloud-runner files stay removed", async () => {
    const retiredFiles = [
      ".github/workflows/runtime.yml",
      ".github/workflows/runtime-runner-cleanup.yml",
      "infra/github-runners.yml",
    ]
    const existing = await Promise.all(
      retiredFiles.map(async (relativePath) => ({
        relativePath,
        exists: await Bun.file(path.join(repositoryRoot, relativePath)).exists(),
      })),
    )

    expect(existing.filter((entry) => entry.exists).map((entry) => entry.relativePath)).toEqual([])
  })

  test("active workflows cannot build or publish the runtime image", async () => {
    const workflowDirectory = path.join(repositoryRoot, ".github/workflows")
    const retiredWorkflowIdentifiers = [
      "aws-actions/configure-aws-credentials",
      "AWS_RUNNER_ROLE_ARN",
      "docker/build-push-action",
      "ghcr.io/cyberful/cyberful-os",
      "runs-on: [self-hosted",
    ]
    const matches: string[] = []

    for await (const relativePath of new Bun.Glob("*.yml").scan({ cwd: workflowDirectory, onlyFiles: true })) {
      const source = await Bun.file(path.join(workflowDirectory, relativePath)).text()
      for (const identifier of retiredWorkflowIdentifiers) {
        if (source.includes(identifier)) matches.push(`${relativePath}: ${identifier}`)
      }
    }

    expect(matches).toEqual([])
  })
})
