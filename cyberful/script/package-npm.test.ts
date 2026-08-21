// ── npm Package Staging Contract ────────────────────────────────────
// Verifies public manifests, platform constraints, staged file layouts, and
// packed archives that users install through the npm distribution channel.
// → cyberful/script/package-npm.ts — stages and packs the release packages.
// ────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  metaManifest,
  packNpmPackage,
  platformManifest,
  repackUniversalX64Package,
  stageMetaPackage,
  stagePlatformPackage,
} from "./package-npm"

const temporaryRoots: string[] = []

test("the repository includes the release notice source", () => {
  const repositoryRoot = path.resolve(import.meta.dir, "../..")
  expect(fs.readFileSync(path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), "utf8")).toContain("## OpenCode")
})

function writePackageDocuments(repositoryRoot: string) {
  for (const file of [
    "README.md",
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
      name: "cyberful",
      version: "1.2.3",
      license: "AGPL-3.0-only",
      homepage: "https://github.com/cyberful/cyberful#readme",
      bugs: { url: "https://github.com/cyberful/cyberful/issues" },
      engines: { node: ">=18" },
      optionalDependencies: {
        "@cyberful-org/cyberful-darwin-arm64": "1.2.3",
        "@cyberful-org/cyberful-darwin-x64": "1.2.3",
        "@cyberful-org/cyberful-linux-x64": "1.2.3",
        "@cyberful-org/cyberful-windows-x64": "1.2.3",
      },
    })
  })

  test("declares npm platform constraints", () => {
    expect(platformManifest("linux", "x64", "1.2.3")).toMatchObject({
      name: "@cyberful-org/cyberful-linux-x64",
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
    writePackageDocuments(repositoryRoot)
    fs.writeFileSync(path.join(repositoryRoot, "cyberful/bin/cyberful"), "launcher")
    fs.writeFileSync(path.join(repositoryRoot, "cyberful/bin/resolve.cjs"), "resolver")
    const packageRoot = path.join(repositoryRoot, "package")
    stageMetaPackage({ repositoryRoot, packageRoot, version: "1.2.3" })
    expect(fs.readdirSync(packageRoot).sort()).toEqual(
      ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "bin", "licenses", "package.json"].sort(),
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
        "package/README.md",
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
    writePackageDocuments(repositoryRoot)
    const packageRoot = path.join(repositoryRoot, "package")
    stagePlatformPackage({ repositoryRoot, packageRoot, platform: "linux", architecture: "x64", version: "1.2.3" })
    expect(fs.readdirSync(packageRoot).sort()).toEqual(
      ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "bin", "licenses", "package.json"].sort(),
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

describe("npm package upload size", () => {
  test("stores one regular baseline-compatible binary in registry-sized x64 packages", async () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-npm-universal-"))
    temporaryRoots.push(repositoryRoot)
    fs.writeFileSync(path.join(repositoryRoot, "LICENSE"), "AGPL-3.0-only")
    writePackageDocuments(repositoryRoot)
    const optimized = Buffer.alloc(1_000_000)
    const baseline = Buffer.alloc(1_000_000)
    for (let index = 0, state = 0x12345678; index < optimized.length; index += 1) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      optimized[index] = state & 0xff
      baseline[index] = (state >>> 8) & 0xff
    }
    for (const [target, contents] of [
      ["cyberful-linux-x64", optimized],
      ["cyberful-linux-x64-baseline", baseline],
    ] as const) {
      const binary = path.join(repositoryRoot, "cyberful/dist", target, "bin/cyberful")
      fs.mkdirSync(path.dirname(binary), { recursive: true })
      fs.writeFileSync(binary, contents)
    }

    const packageRoot = path.join(repositoryRoot, "package")
    stagePlatformPackage({ repositoryRoot, packageRoot, platform: "linux", architecture: "x64", version: "1.2.3" })
    const artifact = packNpmPackage(packageRoot, path.join(repositoryRoot, "packed"))
    const result = await repackUniversalX64Package(artifact)

    expect(result.afterBytes).toBeLessThan(result.beforeBytes * 0.75)
    const extracted = path.join(repositoryRoot, "extracted")
    fs.mkdirSync(extracted)
    const unpack = Bun.spawnSync(["tar", "-xzf", artifact, "-C", extracted], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      maxBuffer: 1_048_576,
    })
    expect(unpack.exitCode).toBe(0)
    const installed = path.join(extracted, "package/bin/cyberful")
    const installedBaseline = path.join(extracted, "package/bin/cyberful-baseline")
    expect(fs.readFileSync(installed)).toEqual(baseline)
    expect(fs.existsSync(installedBaseline)).toBeFalse()
  })

  test("rejects a repacked package that still exceeds the publish limit", async () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-npm-limit-"))
    temporaryRoots.push(repositoryRoot)
    fs.writeFileSync(path.join(repositoryRoot, "LICENSE"), "AGPL-3.0-only")
    writePackageDocuments(repositoryRoot)
    for (const target of ["cyberful-linux-x64", "cyberful-linux-x64-baseline"]) {
      const binary = path.join(repositoryRoot, "cyberful/dist", target, "bin/cyberful")
      fs.mkdirSync(path.dirname(binary), { recursive: true })
      fs.writeFileSync(binary, target)
    }
    const packageRoot = path.join(repositoryRoot, "package")
    stagePlatformPackage({ repositoryRoot, packageRoot, platform: "linux", architecture: "x64", version: "1.2.3" })
    const artifact = packNpmPackage(packageRoot, path.join(repositoryRoot, "packed"))

    await expect(repackUniversalX64Package(artifact, { uploadLimitBytes: 1 })).rejects.toThrow("remains above")
  })
})
