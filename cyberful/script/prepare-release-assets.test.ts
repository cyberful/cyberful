// ── Public Release Archive Contract ─────────────────────────────────
// Builds representative platform packages and verifies users receive every
// supported archive with deterministic names, members, and checksum inputs.
// → scripts/prepare-release-assets.ts — assembles the public archives.
// ────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { prepareReleaseAssets } from "../../scripts/prepare-release-assets"

const temporaryRoots: string[] = []

afterEach(() => {
  temporaryRoots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
})

describe("release archives", () => {
  test("assembles every supported platform and both x64 variants", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-assets-"))
    temporaryRoots.push(root)
    const artifacts = path.join(root, "artifacts")
    const output = path.join(root, "output")
    const write = (file: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, file)
    }
    for (const target of [
      { platform: "linux", architecture: "x64", extension: "", baseline: true },
      { platform: "darwin", architecture: "arm64", extension: "", baseline: false },
      { platform: "darwin", architecture: "x64", extension: "", baseline: true },
      { platform: "windows", architecture: "x64", extension: ".exe", baseline: true },
    ]) {
      const packageRoot = path.join(root, `package-${target.platform}-${target.architecture}`, "package")
      write(path.join(packageRoot, "bin", `cyberful${target.extension}`))
      if (target.baseline) write(path.join(packageRoot, "bin", `cyberful-baseline${target.extension}`))
      fs.mkdirSync(artifacts, { recursive: true })
      const packed = Bun.spawnSync(
        [
          "tar",
          "-czf",
          path.join(artifacts, `cyberful-cli-${target.platform}-${target.architecture}-1.2.3.tgz`),
          "package",
        ],
        { cwd: path.dirname(packageRoot), stdout: "pipe", stderr: "pipe", timeout: 30_000, maxBuffer: 1_048_576 },
      )
      expect(packed.exitCode).toBe(0)
    }
    write(path.join(root, "LICENSE"))
    for (const file of [
      "THIRD_PARTY_NOTICES.md",
      "cyberful/src/tool/assets/fonts/EB_GARAMOND_OFL.txt",
      "cyberful/src/tool/assets/fonts/UBUNTU_FONT_LICENCE.txt",
      "mcps/cyberful-os/wordlists/SECLISTS_LICENSE.txt",
    ])
      write(path.join(root, file))

    prepareReleaseAssets({ repositoryRoot: root, artifacts, output, version: "1.2.3" })
    expect(fs.readdirSync(output).sort()).toEqual(
      [
        "cyberful-cli-darwin-arm64-1.2.3.tgz",
        "cyberful-cli-darwin-x64-1.2.3.tgz",
        "cyberful-cli-linux-x64-1.2.3.tgz",
        "cyberful-cli-windows-x64-1.2.3.tgz",
        "cyberful-v1.2.3-darwin-arm64.tar.gz",
        "cyberful-v1.2.3-darwin-x64.tar.gz",
        "cyberful-v1.2.3-linux-x64.tar.gz",
        "cyberful-v1.2.3-windows-x64.zip",
      ].sort(),
    )
    const linux = Bun.spawnSync(["tar", "-tzf", path.join(output, "cyberful-v1.2.3-linux-x64.tar.gz")], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      maxBuffer: 1_048_576,
    })
    expect(new TextDecoder().decode(linux.stdout)).toContain("bin/cyberful-baseline")
    expect(new TextDecoder().decode(linux.stdout)).toContain("THIRD_PARTY_NOTICES.md")
    expect(new TextDecoder().decode(linux.stdout)).toContain("licenses/EB_GARAMOND_OFL.txt")
    const windows = Bun.spawnSync(["unzip", "-l", path.join(output, "cyberful-v1.2.3-windows-x64.zip")], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      maxBuffer: 1_048_576,
    })
    expect(new TextDecoder().decode(windows.stdout)).toContain("bin/cyberful-baseline.exe")
    for (const file of fs.readdirSync(output).filter((name) => name.endsWith(".tar.gz"))) {
      const gzipHeader = fs.readFileSync(path.join(output, file)).subarray(0, 10)
      expect(gzipHeader.readUInt32LE(4)).toBe(0)
    }

    const first = Object.fromEntries(
      fs
        .readdirSync(output)
        .filter((file) => !file.endsWith(".tgz"))
        .map((file) => [
          file,
          crypto
            .createHash("sha256")
            .update(fs.readFileSync(path.join(output, file)))
            .digest("hex"),
        ]),
    )
    prepareReleaseAssets({ repositoryRoot: root, artifacts, output, version: "1.2.3" })
    expect(
      Object.fromEntries(
        fs
          .readdirSync(output)
          .filter((file) => !file.endsWith(".tgz"))
          .map((file) => [
            file,
            crypto
              .createHash("sha256")
              .update(fs.readFileSync(path.join(output, file)))
              .digest("hex"),
          ]),
      ),
    ).toEqual(first)
  })

  test("removes private staging data when an input package is corrupt", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-assets-failure-"))
    temporaryRoots.push(root)
    const artifacts = path.join(root, "artifacts")
    const output = path.join(root, "output")
    fs.mkdirSync(artifacts)
    fs.writeFileSync(path.join(artifacts, "cyberful-cli-linux-x64-1.2.3.tgz"), "not a tarball")

    expect(() => prepareReleaseAssets({ repositoryRoot: root, artifacts, output, version: "1.2.3" })).toThrow(
      "package listing",
    )
    expect(fs.existsSync(path.join(output, ".stage"))).toBe(false)
  })
})
