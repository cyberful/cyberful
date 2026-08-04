// ── Draft GitHub Release Resolution Contract ────────────────────────
// Verifies a resumable release locates authenticated drafts through the release
// list and refuses ambiguous or malformed records before changing remote assets.
// → scripts/upload-release-assets.ts — resolves and uploads release assets by ID.
// ────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { githubReleaseByTag } from "../../scripts/upload-release-assets"

const temporaryRoots: string[] = []

afterEach(() => {
  temporaryRoots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
})

function fakeGitHub(pages: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-gh-release-"))
  temporaryRoots.push(root)
  const executable = path.join(root, "gh")
  fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s' '${JSON.stringify(pages)}'\n`)
  fs.chmodSync(executable, 0o755)
  return executable
}

describe("draft release recovery", () => {
  test("resolves an authenticated draft by tag and stable release ID", () => {
    const release = githubReleaseByTag(
      "cyberful/cyberful",
      "v0.1.0",
      fakeGitHub([
        [
          {
            id: 364688527,
            tag_name: "v0.1.0",
            draft: true,
            html_url: "https://github.com/cyberful/cyberful/releases/tag/untagged-example",
            upload_url: "https://uploads.github.com/repos/cyberful/cyberful/releases/364688527/assets{?name,label}",
            assets: [{ id: 7, name: "cyberful.tgz", digest: "sha256:abc" }],
          },
        ],
      ]),
    )

    expect(release).toEqual({
      id: 364688527,
      uploadUrl: "https://uploads.github.com/repos/cyberful/cyberful/releases/364688527/assets",
      assets: [{ id: 7, name: "cyberful.tgz", digest: "sha256:abc" }],
    })
  })

  test("refuses duplicate release records for one immutable tag", () => {
    const gh = fakeGitHub([
      [
        {
          id: 1,
          tag_name: "v0.1.0",
          upload_url: "https://uploads.github.com/repos/cyberful/cyberful/releases/1/assets{?name,label}",
          assets: [],
        },
        {
          id: 2,
          tag_name: "v0.1.0",
          upload_url: "https://uploads.github.com/repos/cyberful/cyberful/releases/2/assets{?name,label}",
          assets: [],
        },
      ],
    ])

    expect(() => githubReleaseByTag("cyberful/cyberful", "v0.1.0", gh)).toThrow("multiple releases")
  })
})
