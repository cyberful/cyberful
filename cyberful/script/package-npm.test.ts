// ── npm Package Staging Contract ────────────────────────────────────
// Verifies public manifests, platform constraints, staged file layouts, and
// packed archives that users install through the npm distribution channel.
// → cyberful/script/package-npm.ts — stages and packs the release packages.
// ────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { metaManifest, packNpmPackage, platformManifest, stageMetaPackage, stagePlatformPackage } from "./package-npm"

const temporaryRoots: string[] = []

function writeReleaseNotices(repositoryRoot: string) {
  for (const file of [
    "THIRD_PARTY_NOTICES.md",
    "cyberful/src/tool/assets/fonts/EB_GARAMOND_OFL.txt",
    "cyberful/src/tool/assets/fonts/UBUNTU_FONT_LICENCE.txt",
    "mcps/cyberful-os/wordlists/SECLISTS_LICENSE.txt",
  ]) {
    fs.mkdirSync(path.dirname(path.join(repositoryRoot, file)), { recursive: true })
    fs.writeFileSync(path.join(repositoryRoot, file), file)
  }
}

afterEach(() => {
  temporaryRoots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
})

describe("npm package manifests", () => {
  test("pins every optional platform package to the release version", () => {
    expect(metaManifest("1.2.3")).toMatchObject({
      name: "@cyberful/cli",
      version: "1.2.3",
      license: "AGPL-3.0-only",
      homepage: "https://github.com/cyberful/cyberful#readme",
      bugs: { url: "https://github.com/cyberful/cyberful/issues" },
      engines: { node: ">=18" },
      optionalDependencies: {
        "@cyberful/cli-darwin-arm64": "1.2.3",
        "@cyberful/cli-darwin-x64": "1.2.3",
        "@cyberful/cli-linux-x64": "1.2.3",
        "@cyberful/cli-windows-x64": "1.2.3",
      },
    })
  })

  test("declares npm platform constraints", () => {
    expect(platformManifest("linux", "x64", "1.2.3")).toMatchObject({
      name: "@cyberful/cli-linux-x64",
      version: "1.2.3",
      license: "AGPL-3.0-only",
      homepage: "https://github.com/cyberful/cyberful#readme",
      bugs: { url: "https://github.com/cyberful/cyberful/issues" },
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
    })
    expect(platformManifest("windows", "x64", "1.2.3")).toMatchObject({ os: ["win32"] })
  })
})

describe("npm package staging", () => {
  test("stages the launcher without repository configuration", () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-meta-"))
    temporaryRoots.push(repositoryRoot)
    fs.mkdirSync(path.join(repositoryRoot, "cyberful/bin"), { recursive: true })
    fs.writeFileSync(path.join(repositoryRoot, "LICENSE"), "AGPL-3.0-only")
    writeReleaseNotices(repositoryRoot)
    fs.writeFileSync(path.join(repositoryRoot, "cyberful/bin/cyberful"), "launcher")
    fs.writeFileSync(path.join(repositoryRoot, "cyberful/bin/resolve.cjs"), "resolver")
    const packageRoot = path.join(repositoryRoot, "package")
    stageMetaPackage({ repositoryRoot, packageRoot, version: "1.2.3" })
    expect(fs.readdirSync(packageRoot).sort()).toEqual(
      ["LICENSE", "THIRD_PARTY_NOTICES.md", "bin", "licenses", "package.json"].sort(),
    )
    expect(fs.readdirSync(path.join(packageRoot, "bin")).sort()).toEqual(["cyberful", "resolve.cjs"])
    const artifact = packNpmPackage(packageRoot, path.join(repositoryRoot, "packed"))
    const listing = Bun.spawnSync(["tar", "-tzf", artifact], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      maxBuffer: 1_048_576,
    })
    expect(listing.exitCode).toBe(0)
    expect(new TextDecoder().decode(listing.stdout).trim().split("\n").sort()).toEqual(
      [
        "package/LICENSE",
        "package/THIRD_PARTY_NOTICES.md",
        "package/bin/cyberful",
        "package/bin/resolve.cjs",
        "package/licenses/EB_GARAMOND_OFL.txt",
        "package/licenses/SECLISTS_LICENSE.txt",
        "package/licenses/UBUNTU_FONT_LICENCE.txt",
        "package/package.json",
      ].sort(),
    )
  })

  test("stages normal and baseline x64 binaries", () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-platform-"))
    temporaryRoots.push(repositoryRoot)
    for (const file of [
      "LICENSE",
      "cyberful/dist/cyberful-linux-x64/bin/cyberful",
      "cyberful/dist/cyberful-linux-x64-baseline/bin/cyberful",
    ]) {
      fs.mkdirSync(path.dirname(path.join(repositoryRoot, file)), { recursive: true })
      fs.writeFileSync(path.join(repositoryRoot, file), file)
    }
    writeReleaseNotices(repositoryRoot)
    const packageRoot = path.join(repositoryRoot, "package")
    stagePlatformPackage({ repositoryRoot, packageRoot, platform: "linux", architecture: "x64", version: "1.2.3" })
    expect(fs.readdirSync(packageRoot).sort()).toEqual(
      ["LICENSE", "THIRD_PARTY_NOTICES.md", "bin", "licenses", "package.json"].sort(),
    )
    expect(fs.readdirSync(path.join(packageRoot, "bin")).sort()).toEqual(["cyberful", "cyberful-baseline"])
  })

  test("cannot erase the source repository when staging is misconfigured", () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-stage-boundary-"))
    temporaryRoots.push(repositoryRoot)
    fs.writeFileSync(path.join(repositoryRoot, "LICENSE"), "AGPL-3.0-only")

    expect(() => stageMetaPackage({ repositoryRoot, packageRoot: repositoryRoot, version: "1.2.3" })).toThrow(
      "cannot replace the repository root",
    )
    expect(fs.readFileSync(path.join(repositoryRoot, "LICENSE"), "utf8")).toBe("AGPL-3.0-only")
  })
})
