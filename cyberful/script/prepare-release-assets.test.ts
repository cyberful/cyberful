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
import { gzipSync } from "node:zlib"
import { ATTACK_INDEX_URL, ATTACK_LICENSE_URL } from "@/mitre-attack/builder"
import { ATTACK_DOMAINS, type AttackSnapshotManifest } from "@/mitre-attack/types"
import { prepareReleaseAssets } from "../../scripts/prepare-release-assets"

const temporaryRoots: string[] = []

afterEach(() => {
  temporaryRoots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
})

function sha256(value: string | Uint8Array) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function writeFixture(file: string, value: string | Uint8Array) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}

function writeAttackFixture(artifacts: string) {
  const snapshotRoot = path.join(artifacts, "mitre-attack-snapshot")
  const index = Buffer.from('{"fixture":"index"}\n')
  const database = Buffer.from("fixture sqlite bytes")
  const compressed = gzipSync(database, { level: 9 })
  const license = Buffer.from("The MITRE Corporation grants a royalty-free license.\n")
  const sbom = Buffer.from('{"spdxVersion":"SPDX-2.3"}\n')
  const domains = ATTACK_DOMAINS.map((domain) => {
    const sourceFile = `source/${domain}-attack-19.2.json`
    const source = Buffer.from(`{"type":"bundle","domain":"${domain}"}\n`)
    writeFixture(path.join(snapshotRoot, sourceFile), source)
    return {
      domain,
      collection_id: `collection--${domain}`,
      collection_name: `${domain} ATT&CK`,
      version: "19.2",
      modified: "2026-08-18T00:00:00Z",
      url: `https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/${domain}-attack/${domain}-attack-19.2.json`,
      source_file: sourceFile,
      sha256: sha256(source),
      bytes: source.byteLength,
      objects: 1,
      relationships: 1,
    }
  })
  const manifest = {
    schema_version: 1,
    snapshot_id: "attack-enterprise-19.2_mobile-19.2_ics-19.2-fixture",
    generated_at: "2026-08-20T00:00:00.000Z",
    cyberful: { version: "1.2.3", build_id: "fixture-build" },
    index: {
      url: ATTACK_INDEX_URL,
      modified: "2026-08-18T00:00:00Z",
      sha256: sha256(index),
      bytes: index.byteLength,
      source_file: "source/index.json",
    },
    domains,
    database: {
      schema_version: 1,
      file: "mitre-attack.sqlite",
      sha256: sha256(database),
      bytes: database.byteLength,
      gzip_file: "mitre-attack.sqlite.gz",
      gzip_sha256: sha256(compressed),
      gzip_bytes: compressed.byteLength,
    },
    license: {
      url: ATTACK_LICENSE_URL,
      file: "LICENSE.txt",
      sha256: sha256(license),
      bytes: license.byteLength,
    },
  } satisfies AttackSnapshotManifest
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  writeFixture(path.join(snapshotRoot, manifest.index.source_file), index)
  writeFixture(path.join(snapshotRoot, manifest.database.file), database)
  writeFixture(path.join(snapshotRoot, manifest.database.gzip_file), compressed)
  writeFixture(path.join(snapshotRoot, manifest.license.file), license)
  writeFixture(path.join(snapshotRoot, "manifest.json"), manifestBytes)
  writeFixture(path.join(snapshotRoot, "SBOM.spdx.json"), sbom)
  const checksums = [
    [sha256(manifestBytes), "manifest.json"],
    [sha256(sbom), "SBOM.spdx.json"],
    [manifest.index.sha256, manifest.index.source_file],
    ...manifest.domains.map((domain) => [domain.sha256, domain.source_file]),
    [manifest.database.sha256, manifest.database.file],
    [manifest.database.gzip_sha256, manifest.database.gzip_file],
    [manifest.license.sha256, manifest.license.file],
  ]
    .map(([digest, file]) => `${digest}  ${file}`)
    .join("\n")
  writeFixture(path.join(snapshotRoot, "SHA256SUMS"), `${checksums}\n`)
  for (const target of ["linux-x64", "darwin-arm64", "darwin-x64", "windows-x64"]) {
    writeFixture(path.join(artifacts, target, "mitre-attack-manifest.json"), manifestBytes)
  }
  return manifest.snapshot_id
}

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
          path.join(artifacts, `cyberful-org-cyberful-${target.platform}-${target.architecture}-1.2.3.tgz`),
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

    const attackSnapshotID = writeAttackFixture(artifacts)
    prepareReleaseAssets({ repositoryRoot: root, artifacts, output, version: "1.2.3" })
    expect(fs.readdirSync(output).sort()).toEqual(
      [
        "cyberful-org-cyberful-darwin-arm64-1.2.3.tgz",
        "cyberful-org-cyberful-darwin-x64-1.2.3.tgz",
        "cyberful-org-cyberful-linux-x64-1.2.3.tgz",
        "cyberful-org-cyberful-windows-x64-1.2.3.tgz",
        `cyberful-mitre-attack-${attackSnapshotID}.tar.gz`,
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
    const attack = Bun.spawnSync(
      ["tar", "-tzf", path.join(output, `cyberful-mitre-attack-${attackSnapshotID}.tar.gz`)],
      { stdout: "pipe", stderr: "pipe", timeout: 30_000, maxBuffer: 1_048_576 },
    )
    expect(new TextDecoder().decode(attack.stdout)).toContain("source/enterprise-attack-19.2.json")
    expect(new TextDecoder().decode(attack.stdout)).toContain("LICENSE.txt")
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
    fs.writeFileSync(path.join(artifacts, "cyberful-org-cyberful-linux-x64-1.2.3.tgz"), "not a tarball")

    expect(() => prepareReleaseAssets({ repositoryRoot: root, artifacts, output, version: "1.2.3" })).toThrow(
      "package listing",
    )
    expect(fs.existsSync(path.join(output, ".stage"))).toBe(false)
  })
})
