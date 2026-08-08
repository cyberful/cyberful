// ── EVM Evidence Index Tests ────────────────────────────────────────────────
// Verifies authenticated source provenance, artifact containment and hashing,
// lab metadata, and explicit-only atomic indexing.
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { handleSourceImport } from "./source-import"
import { handleEvmEvidence } from "./evm-evidence"

let root = ""
let workarea = ""
let sourceStore = ""
const previous: Record<string, string | undefined> = {}
const importKey = "evm-evidence-import-attestation-key-with-thirty-two-bytes"

async function git(args: readonly string[], cwd: string) {
  const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr, truncated: false }
}

async function fixtureGit(args: readonly string[], cwd: string) {
  if (args.includes("clone")) {
    const destination = args.at(-1)
    if (!destination) throw new Error("fixture clone has no destination")
    const initialized = await git(["init", "--quiet", destination], cwd)
    if (initialized.exitCode !== 0) return initialized
    await writeFile(path.join(destination, "Contract.sol"), "contract Contract {}\n")
    await git(["add", "--", "Contract.sol"], destination)
    return git(
      ["-c", "user.name=Cyberful Tests", "-c", "user.email=cyberful@localhost", "commit", "--quiet", "-m", "fixture"],
      destination,
    )
  }
  return git(args, cwd)
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cyberful-evm-evidence-"))
  workarea = path.join(root, "workarea")
  sourceStore = path.join(root, "source-store")
  await Promise.all([mkdir(workarea), mkdir(path.join(sourceStore, "import"), { recursive: true })])
  for (const key of [
    "CYBERFUL_SUBSYSTEM_WORKAREA_ROOT",
    "CYBERFUL_SUBSYSTEM_SOURCE_ROOT",
    "CYBERFUL_SOURCE_STORE_ROOT",
    "CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY",
    "CYBERFUL_SUBSYSTEM_WORKFLOW",
    "CYBERFUL_OS_CONTAINER",
  ])
    previous[key] = process.env[key]
  process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = workarea
  process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT = workarea
  process.env.CYBERFUL_SOURCE_STORE_ROOT = sourceStore
  process.env.CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY = importKey
  process.env.CYBERFUL_SUBSYSTEM_WORKFLOW = "bug-bounty"
  process.env.CYBERFUL_OS_CONTAINER = "cyberful-os-evidence-test"
  await handleSourceImport(
    { url: "https://github.com/example/contracts.git", repository: "contracts", submodules: "none" },
    { confirm: async () => true, resolveHost: async () => ["8.8.8.8"], runGit: fixtureGit },
  )
})

afterEach(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

async function prepareEvidenceFixture(builds: readonly Record<string, unknown>[]) {
  const project = path.join(workarea, ".cyberful-evm", "projects", "lab-negative", "contracts")
  const buildInfoDirectory = path.join(project, "out", "build-info")
  await Promise.all([
    mkdir(path.join(workarea, "raw", "evm"), { recursive: true }),
    mkdir(buildInfoDirectory, { recursive: true }),
  ])
  await writeFile(path.join(workarea, "raw", "evm", "proof.txt"), "proof\n")
  await writeFile(
    path.join(workarea, "raw", "evm", "lab.json"),
    JSON.stringify({
      lab_id: "lab-negative",
      chain_id: 31337,
      repositories: [
        {
          repository: "contracts",
          project_path: ".cyberful-evm/projects/lab-negative/contracts",
        },
      ],
    }),
  )
  await Promise.all(
    builds.map((build, index) => writeFile(path.join(buildInfoDirectory, `build-${index}.json`), JSON.stringify(build))),
  )
  return {
    action: "record",
    kind: "poc",
    artifact: "raw/evm/proof.txt",
    command: "forge test --match-test testExploit -vvvv",
    repository: "contracts",
    solidity: "0.8.28",
  }
}

function foundryBuildInfo(solidity = "0.8.28") {
  return {
    _format: "ethers-rs-sol-build-info-1",
    language: "Solidity",
    solcVersion: solidity,
    solcLongVersion: `${solidity}+commit.7893614a`,
    input: {},
    output: {},
  }
}

async function attestedDocker(args: readonly string[]) {
  if (args[0] === "inspect")
    return { exitCode: 0, stdout: `true engagement cyberful-os sha256:${"a".repeat(64)}\n`, stderr: "" }
  if (args[0] === "exec")
    return {
      exitCode: 0,
      stdout: `forge Version: 1.7.1\nCommit SHA: ${"b".repeat(40)}\nBuild Profile: dist\n`,
      stderr: "",
    }
  throw new Error(`unexpected Docker evidence call: ${args.join(" ")}`)
}

describe("EVM finding evidence", () => {
  test("hashes an existing artifact and binds source, toolchain, lab, and replay parameters", async () => {
    const content = "decisive local PoC\n"
    const project = path.join(workarea, ".cyberful-evm", "projects", "lab-test", "contracts")
    const buildInfoDirectory = path.join(project, "out", "build-info")
    await Promise.all([
      mkdir(path.join(workarea, "raw", "evm"), { recursive: true }),
      mkdir(buildInfoDirectory, { recursive: true }),
    ])
    await writeFile(path.join(workarea, "raw", "evm", "poc.txt"), content)
    const buildInfo = JSON.stringify({
      _format: "ethers-rs-sol-build-info-1",
      language: "Solidity",
      solcVersion: "0.8.28",
      solcLongVersion: "0.8.28+commit.7893614a",
      input: {},
      output: {},
    })
    await writeFile(path.join(buildInfoDirectory, "build.json"), buildInfo)
    await writeFile(
      path.join(workarea, "raw", "evm", "lab.json"),
      JSON.stringify({
        lab_id: "lab-test",
        chain_id: 31337,
        fork: { block: 123456 },
        repositories: [
          {
            repository: "contracts",
            project_path: ".cyberful-evm/projects/lab-test/contracts",
          },
        ],
      }),
    )
    const transactionHash = `0x${"f".repeat(64)}`
    const docker = async (args: readonly string[]) => {
      if (args[0] === "inspect")
        return {
          exitCode: 0,
          stdout: `true engagement cyberful-os sha256:${"a".repeat(64)}\n`,
          stderr: "",
        }
      if (args[0] === "exec")
        return {
          exitCode: 0,
          stdout: `forge Version: 1.7.1\nCommit SHA: ${"b".repeat(40)}\nBuild Profile: dist\n`,
          stderr: "",
        }
      throw new Error(`unexpected Docker evidence call: ${args.join(" ")}`)
    }
    const result = await handleEvmEvidence(
      {
        action: "record",
        kind: "poc",
        artifact: "raw/evm/poc.txt",
        command: "forge test --match-test testExploit -vvvv",
        repository: "contracts",
        solidity: "0.8.28",
        seed: "42",
        runs: 256,
        transaction_hash: transactionHash,
      },
      { docker },
    )
    expect(result).toMatchObject({
      recorded: true,
      index_path: "raw/evm/evidence.json",
      evidence: {
        kind: "poc",
        artifact: {
          path: "raw/evm/poc.txt",
          sha256: createHash("sha256").update(content).digest("hex"),
        },
        source: { repository: "contracts" },
        toolchain: {
          foundry: "v1.7.1",
          solidity: "0.8.28",
          attestation: {
            foundry_commit: "b".repeat(40),
            image_id: `sha256:${"a".repeat(64)}`,
            build_info: {
              path: ".cyberful-evm/projects/lab-test/contracts/out/build-info/build.json",
              sha256: createHash("sha256").update(buildInfo).digest("hex"),
              format: "ethers-rs-sol-build-info-1",
              solidity_long: "0.8.28+commit.7893614a",
            },
          },
        },
        lab: { lab_id: "lab-test", chain_id: 31337, fork_block: 123456 },
        transaction_hash: transactionHash,
      },
    })
    const listed = await handleEvmEvidence({ action: "list" })
    expect(listed.evidence).toHaveLength(1)
    expect(await readFile(path.join(workarea, "raw", "evm", "evidence.json"), "utf8")).not.toContain(content)
  })

  test("rejects missing artifacts and symlink escapes", async () => {
    const common = {
      action: "record",
      kind: "trace",
      command: "forge test -vvvv",
      repository: "contracts",
      solidity: "0.8.28",
    }
    await expect(handleEvmEvidence({ ...common, artifact: "missing.txt" })).rejects.toThrow()
    await writeFile(path.join(root, "outside.txt"), "outside\n")
    await symlink(path.join(root, "outside.txt"), path.join(workarea, "escape.txt"))
    await expect(handleEvmEvidence({ ...common, artifact: "escape.txt" })).rejects.toThrow("symlink")
  })

  test("rejects spoofed or ambiguous compiler evidence before recording", async () => {
    const mismatch = await prepareEvidenceFixture([foundryBuildInfo("0.8.29")])
    await expect(handleEvmEvidence(mismatch, { docker: attestedDocker })).rejects.toThrow("version mismatch")
    await rm(path.join(workarea, ".cyberful-evm"), { recursive: true, force: true })
    const ambiguous = await prepareEvidenceFixture([foundryBuildInfo(), foundryBuildInfo()])
    await expect(handleEvmEvidence(ambiguous, { docker: attestedDocker })).rejects.toThrow("multiple Foundry build-info")
  })

  test("rejects manipulated build-info, path escapes, and unattested containers", async () => {
    const malformed = await prepareEvidenceFixture([{ ...foundryBuildInfo(), _format: "caller-authored" }])
    await expect(handleEvmEvidence(malformed, { docker: attestedDocker })).rejects.toThrow("not a supported Foundry")
    await expect(
      handleEvmEvidence({ ...malformed, build_info: "../../outside.json" }, { docker: attestedDocker }),
    ).rejects.toThrow("escapes")
    await rm(path.join(workarea, ".cyberful-evm"), { recursive: true, force: true })
    const valid = await prepareEvidenceFixture([foundryBuildInfo()])
    await expect(
      handleEvmEvidence(valid, {
        docker: async (args) =>
          args[0] === "inspect"
            ? { exitCode: 0, stdout: `true caller cyberful-os sha256:${"a".repeat(64)}\n`, stderr: "" }
            : attestedDocker(args),
      }),
    ).rejects.toThrow("unattested cyberful-os container")
  })
})
