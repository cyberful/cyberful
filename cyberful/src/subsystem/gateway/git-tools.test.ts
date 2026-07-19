// ── Secure Review And Remediation Git Tests ──────────────────────
// Exercises local-ref review preparation and isolated remediation worktrees
// without fetching, pushing, or touching the caller's dirty checkout.
// → cyberful/src/subsystem/gateway/git-tools.ts — owns the tested Git boundary.
// ─────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { authorizeFixedFinding, handleGitTool, type GitToolHooks, type PublishCandidate } from "./git-tools"
import { attestSourceImportManifest, sourceImportTreeFingerprint } from "./source-import"
import { isRecord } from "@/util/record"

let root = ""
let project = ""
let workarea = ""
let sourceStore = ""
let testBin = ""
let previousSource: string | undefined
let previousWorkarea: string | undefined
let previousSessionLogRoot: string | undefined
let previousProofKey: string | undefined
let previousLedgerKey: string | undefined
let previousSourceStore: string | undefined
let previousImportKey: string | undefined
let previousContainer: string | undefined
let previousPath: string | undefined

async function run(argv: string[], cwd = project) {
  const process = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${stderr}`)
  return stdout.trim()
}

const hooks: GitToolHooks = {
  confirmPublish: async () => false,
  fixedFindings: async () => ({ ok: true, unresolved: [] }),
}

function recordValue(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} is not an object`)
  return value
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string") throw new Error(`${context} is not a string`)
  return value
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cyberful-git-tools-"))
  project = path.join(root, "project")
  workarea = path.join(project, "work", "engagement")
  sourceStore = path.join(root, "source-store")
  await mkdir(workarea, { recursive: true })
  await mkdir(path.join(sourceStore, "import"), { recursive: true })
  await run(["git", "init", "--initial-branch=main", project], root)
  await run(["git", "config", "user.name", "Cyberful Test"])
  await run(["git", "config", "user.email", "cyberful@example.invalid"])
  await writeFile(path.join(project, ".gitignore"), "/work/\n")
  await writeFile(path.join(project, "service.ts"), "export const value = 1\n")
  await run(["git", "add", "."])
  await run(["git", "commit", "-m", "initial"])
  testBin = path.join(root, "bin")
  await mkdir(testBin)
  await writeFile(
    path.join(testBin, "docker"),
    [
      "#!/bin/sh",
      'if [ -n "${CYBERFUL_REMEDIATION_PROOF_KEY:-}" ]; then exit 98; fi',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "env" ]; then',
      "    shift",
      '    if [ "${1:-}" = "CI=1" ]; then shift; fi',
      '    exec "$@"',
      "  fi",
      "  shift",
      "done",
      "exit 127",
      "",
    ].join("\n"),
  )
  await writeFile(
    path.join(testBin, "remediation-case"),
    [
      "#!/bin/sh",
      'case "${1:-}" in',
      "  /workspace/remediation/checkout|/workspace/remediation/checkout/.) ;;",
      "  *) exit 97 ;;",
      "esac",
      `grep -q 'safe(input)' "${path.join(workarea, "remediation", "checkout", "service.ts")}"`,
      "",
    ].join("\n"),
  )
  await Promise.all([chmod(path.join(testBin, "docker"), 0o700), chmod(path.join(testBin, "remediation-case"), 0o700)])
  previousSource = process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT
  previousWorkarea = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT
  previousSessionLogRoot = process.env.CYBERFUL_SUBSYSTEM_SESSION_LOG_ROOT
  previousProofKey = process.env.CYBERFUL_REMEDIATION_PROOF_KEY
  previousLedgerKey = process.env.CYBERFUL_CODE_GRAPH_LEDGER_KEY
  previousSourceStore = process.env.CYBERFUL_SOURCE_STORE_ROOT
  previousImportKey = process.env.CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY
  previousContainer = process.env.CYBERFUL_OS_CONTAINER
  previousPath = process.env.PATH
  process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT = project
  process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = workarea
  process.env.CYBERFUL_SUBSYSTEM_SESSION_LOG_ROOT = path.join(project, "logs", "session-logs")
  process.env.CYBERFUL_REMEDIATION_PROOF_KEY = "test-remediation-proof-key-that-is-never-shared-with-the-model"
  process.env.CYBERFUL_CODE_GRAPH_LEDGER_KEY = "test-code-graph-ledger-key-that-is-never-shared-with-the-model"
  process.env.CYBERFUL_SOURCE_STORE_ROOT = sourceStore
  process.env.CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY =
    "test-source-import-attestation-key-that-is-never-shared-with-the-model"
  process.env.CYBERFUL_OS_CONTAINER = "cyberful-os-test"
  process.env.PATH = `${testBin}${path.delimiter}${previousPath ?? ""}`
})

afterEach(async () => {
  if (previousSource === undefined) delete process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT
  else process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT = previousSource
  if (previousWorkarea === undefined) delete process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT
  else process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = previousWorkarea
  if (previousSessionLogRoot === undefined) delete process.env.CYBERFUL_SUBSYSTEM_SESSION_LOG_ROOT
  else process.env.CYBERFUL_SUBSYSTEM_SESSION_LOG_ROOT = previousSessionLogRoot
  if (previousProofKey === undefined) delete process.env.CYBERFUL_REMEDIATION_PROOF_KEY
  else process.env.CYBERFUL_REMEDIATION_PROOF_KEY = previousProofKey
  if (previousLedgerKey === undefined) delete process.env.CYBERFUL_CODE_GRAPH_LEDGER_KEY
  else process.env.CYBERFUL_CODE_GRAPH_LEDGER_KEY = previousLedgerKey
  if (previousSourceStore === undefined) delete process.env.CYBERFUL_SOURCE_STORE_ROOT
  else process.env.CYBERFUL_SOURCE_STORE_ROOT = previousSourceStore
  if (previousImportKey === undefined) delete process.env.CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY
  else process.env.CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY = previousImportKey
  if (previousContainer === undefined) delete process.env.CYBERFUL_OS_CONTAINER
  else process.env.CYBERFUL_OS_CONTAINER = previousContainer
  if (previousPath === undefined) delete process.env.PATH
  else process.env.PATH = previousPath
  await rm(root, { recursive: true, force: true })
})

async function prepareVerifiedRemediation(sessionID: string, findingID: string) {
  const prepared = recordValue(
    await handleGitTool(sessionID, "remediation_prepare", { slug: findingID }, hooks),
    "remediation preparation",
  )
  await handleGitTool(
    sessionID,
    "remediation_test",
    {
      command: ["remediation-case", "/workspace/remediation/checkout"],
      stage: "pre-fix",
      test_case: "service-input-is-sanitized",
      finding_ids: [findingID],
      expected_exit_codes: [1],
    },
    hooks,
  )
  const checkout = path.join(workarea, stringValue(prepared.checkout, "remediation checkout"))
  await writeFile(path.join(checkout, "service.ts"), "export const value = safe(input)\n")
  await handleGitTool(
    sessionID,
    "remediation_test",
    {
      command: ["remediation-case", "/workspace/remediation/checkout/."],
      stage: "post-fix",
      test_case: "service-input-is-sanitized",
      finding_ids: [findingID],
      expected_exit_codes: [0],
    },
    hooks,
  )
  return checkout
}

describe("Git workflow gateway tools", () => {
  test("prepares a local merge-base review with dirty and untracked overlays", async () => {
    await run(["git", "switch", "-c", "feature"])
    await writeFile(path.join(project, "service.ts"), "export const value = eval(input)\n")
    await writeFile(path.join(project, "new.py"), "exec(user_input)\n")

    const review = recordValue(await handleGitTool("ses_review", "review_prepare", {}, hooks), "review preparation")
    expect(review).toMatchObject({ branch: "feature", includes_working_tree: true, untracked: ["new.py"] })
    expect(review.patch_sha256).toMatch(/^[a-f0-9]{64}$/)
    const patch = await readFile(path.join(workarea, stringValue(review.patch_path, "review patch path")), "utf8")
    expect(patch).toContain("eval(input)")
    expect(patch).toContain("exec(user_input)")
  })

  test("excludes runtime-owned workarea and transcript files from a clean review", async () => {
    await mkdir(path.join(project, "logs", "session-logs"), { recursive: true })
    await Promise.all([
      writeFile(path.join(workarea, "MISSION.md"), "runtime mission\n"),
      writeFile(path.join(project, "logs", "session-logs", "session-ses_review.jsonl"), "{}\n"),
    ])

    const review = recordValue(
      await handleGitTool("ses_review", "review_prepare", {}, hooks),
      "clean review preparation",
    )
    expect(review).toMatchObject({
      version: 2,
      review_status: "empty",
      reviewable_files: [],
      excluded_owned_roots: ["logs/session-logs", "work/engagement"],
    })
    expect(review.untracked).toEqual([])
    expect(await readFile(path.join(workarea, stringValue(review.patch_path, "review patch path")), "utf8")).toBe("")
  })

  test("fails closed when a runtime-owned root collides with tracked project files", async () => {
    await writeFile(path.join(workarea, "project-owned.txt"), "tracked project content\n")
    await run(["git", "add", "-f", "work/engagement/project-owned.txt"])
    await run(["git", "commit", "-m", "track colliding runtime path"])

    await expect(handleGitTool("ses_review", "review_prepare", {}, hooks)).rejects.toThrow(
      "collide with tracked project files",
    )
  })

  test("fails closed when tracked review output exceeds its host limit", async () => {
    await writeFile(path.join(project, "service.ts"), "a".repeat(2_200_000))

    await expect(handleGitTool("ses_review_large", "review_prepare", {}, hooks)).rejects.toThrow(
      "Review patch generation exceeded",
    )
    await expect(readFile(path.join(workarea, "raw", "secure-review", "manifest.json"))).rejects.toThrow()
  })

  test("applies one aggregate patch limit across tracked and untracked changes", async () => {
    await writeFile(path.join(project, "service.ts"), "a".repeat(1_100_000))
    await writeFile(path.join(project, "untracked.txt"), "b".repeat(1_100_000))

    await expect(handleGitTool("ses_review_aggregate", "review_prepare", {}, hooks)).rejects.toThrow(
      "aggregate host byte limit",
    )
    await expect(readFile(path.join(workarea, "raw", "secure-review", "changes.patch"))).rejects.toThrow()
  })

  test("reviews and remediates a manifest-backed source import instead of the host project", async () => {
    const importRoot = path.join(sourceStore, "import")
    const imported = path.join(importRoot, "repository")
    await run(["git", "init", "--initial-branch=main", imported], root)
    await run(["git", "config", "user.name", "Cyberful Import"], imported)
    await run(["git", "config", "user.email", "import@example.invalid"], imported)
    await writeFile(path.join(imported, "imported.ts"), "export const imported = 1\n")
    await run(["git", "add", "."], imported)
    await run(["git", "commit", "-m", "imported base"], imported)
    const importedBase = await run(["git", "rev-parse", "HEAD"], imported)
    await run(["git", "switch", "-c", "feature"], imported)
    await writeFile(path.join(imported, "imported.ts"), "export const imported = eval(input)\n")
    await run(["git", "add", "."], imported)
    await run(["git", "commit", "-m", "feature"], imported)
    const importedHead = await run(["git", "rev-parse", "HEAD"], imported)
    await run(["git", "update-ref", "refs/cyberful/import/0", importedBase], imported)
    const tree = await sourceImportTreeFingerprint(imported)
    const manifest = attestSourceImportManifest({
      version: 2,
      url: "https://github.com/example/project.git",
      host: "github.com",
      additional_refs: ["main"],
      local_refs: { main: "refs/cyberful/import/0" },
      sealed_refs: [{ requested_ref: "main", local_ref: "refs/cyberful/import/0", commit: importedBase }],
      commit: importedHead,
      tree,
      resolved_addresses: ["8.8.8.8"],
      files_on_disk: tree.files,
      bytes_on_disk: tree.bytes,
      network_complete: true,
      history_complete: true,
      hooks: false,
      submodules: false,
      lfs_smudge: false,
      dependencies: false,
      created_at: "2026-07-16T12:00:00.000Z",
    })
    await writeFile(path.join(importRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
    await writeFile(path.join(project, "service.ts"), "host checkout must not be reviewed\n")

    const review = recordValue(
      await handleGitTool("ses_import_review", "review_prepare", {}, hooks),
      "import review preparation",
    )
    const patch = await readFile(
      path.join(workarea, stringValue(review.patch_path, "import review patch path")),
      "utf8",
    )
    expect(patch).toContain("eval(input)")
    expect(patch).not.toContain("host checkout must not be reviewed")

    const prepared = recordValue(
      await handleGitTool("ses_import_remediation", "remediation_prepare", { slug: "imported" }, hooks),
      "import remediation preparation",
    )
    const checkout = stringValue(prepared.checkout, "import remediation checkout")
    expect(prepared.base).toBe(importedHead)
    expect(prepared.excluded_dirty_paths).toEqual([])
    expect(await readFile(path.join(workarea, checkout, "imported.ts"), "utf8")).toBe(
      "export const imported = eval(input)\n",
    )
    await expect(readFile(path.join(workarea, checkout, "service.ts"))).rejects.toThrow()
    expect(await run(["git", "branch", "--show-current"])).toBe("main")
  })

  test("creates a HEAD-only remediation branch and leaves dirty source untouched", async () => {
    await writeFile(path.join(project, "service.ts"), "dirty user change\n")
    const prepared = recordValue(
      await handleGitTool("ses_remediation_123456", "remediation_prepare", { slug: "unsafe eval" }, hooks),
      "remediation preparation",
    )
    expect(prepared.branch).toBe("cyberful/remediate/unsafe-eval-tion123456")
    expect(prepared.excluded_dirty_paths).toContain("service.ts")
    expect(
      await readFile(path.join(workarea, stringValue(prepared.checkout, "remediation checkout"), "service.ts"), "utf8"),
    ).toBe("export const value = 1\n")
    expect(await readFile(path.join(project, "service.ts"), "utf8")).toBe("dirty user change\n")

    const reused = recordValue(
      await handleGitTool("ses_remediation_123456", "remediation_prepare", {}, hooks),
      "reused remediation preparation",
    )
    expect(reused).toMatchObject({ reused: true, branch: prepared.branch })
  })

  test("authenticates the remediation manifest before accepting any branch value", async () => {
    const sessionID = "ses_manifest_attestation"
    await handleGitTool(sessionID, "remediation_prepare", { slug: "manifest" }, hooks)
    const manifestPath = path.join(workarea, "remediation", "manifest.json")
    const manifest = recordValue(JSON.parse(await readFile(manifestPath, "utf8")), "remediation manifest")
    expect(manifest.attestation).toMatch(/^[a-f0-9]{64}$/)
    manifest.branch = "cyberful/remediate/safe:refs/heads/injected"
    await writeFile(manifestPath, JSON.stringify(manifest))
    await expect(handleGitTool(sessionID, "remediation_prepare", {}, hooks)).rejects.toThrow("invalid host attestation")
  })

  test("re-derives the remediation branch from the registered worktree", async () => {
    const sessionID = "ses_manifest_branch"
    const prepared = recordValue(
      await handleGitTool(sessionID, "remediation_prepare", { slug: "branch" }, hooks),
      "branch remediation preparation",
    )
    await run(
      ["git", "branch", "-m", "cyberful/remediate/different-safe-branch"],
      path.join(workarea, stringValue(prepared.checkout, "branch remediation checkout")),
    )
    await expect(handleGitTool(sessionID, "remediation_prepare", {}, hooks)).rejects.toThrow("branch differs")
  })

  test("rejects remote refs that are not already present locally", async () => {
    await expect(
      handleGitTool("ses_review", "review_prepare", { base_ref: "origin/not-fetched" }, hooks),
    ).rejects.toThrow("Local ref")
  })

  test("rejects symlinked review and remediation directories before Git can write through them", async () => {
    const outsideRaw = path.join(root, "outside-raw")
    await mkdir(outsideRaw)
    await symlink(outsideRaw, path.join(workarea, "raw"))
    await expect(handleGitTool("ses_review", "review_prepare", {}, hooks)).rejects.toThrow("symlink")
    expect(await readdir(outsideRaw)).toEqual([])

    await rm(path.join(workarea, "raw"))
    const outsideRemediation = path.join(root, "outside-remediation")
    await mkdir(outsideRemediation)
    await symlink(outsideRemediation, path.join(workarea, "remediation"))
    await expect(
      handleGitTool("ses_remediation_symlink", "remediation_prepare", { slug: "blocked" }, hooks),
    ).rejects.toThrow("symlink")
    expect(await readdir(outsideRemediation)).toEqual([])
  })

  test("rejects forged remediation test records before staging or publication", async () => {
    await handleGitTool("ses_attestation_123", "remediation_prepare", { slug: "attestation" }, hooks)
    const tests = path.join(workarea, "raw", "remediation", "tests")
    await mkdir(tests, { recursive: true })
    const command = ["bun", "test"]
    const commandSha256 = createHash("sha256").update(JSON.stringify(command)).digest("hex")
    const testCase = "forged-current-format-proof"
    const findingIDs = ["finding-1"]
    const forged = {
      version: 2,
      command,
      test_case: testCase,
      command_sha256: commandSha256,
      command_identity_sha256: commandSha256,
      case_sha256: createHash("sha256")
        .update(
          `cyberful-remediation-case-v2\0${JSON.stringify({
            test_case: testCase,
            command_identity_sha256: commandSha256,
            finding_ids: findingIDs,
          })}`,
        )
        .digest("hex"),
      stage: "post-fix",
      finding_ids: findingIDs,
      expected_exit_codes: [0],
      exit_code: 0,
      expectation_met: true,
      output_sha256: "0".repeat(64),
      tree_fingerprint: "0".repeat(64),
      created_at: new Date(0).toISOString(),
      attestation: "0".repeat(64),
    }
    await writeFile(path.join(tests, "forged.json"), JSON.stringify(forged))
    await writeFile(path.join(tests, "latest.json"), JSON.stringify(forged))

    await expect(
      handleGitTool(
        "ses_attestation_123",
        "remediation_publish",
        { title: "Fix", commit_message: "fix: security issue", finding_ids: ["finding-1"] },
        hooks,
      ),
    ).rejects.toThrow("invalid host attestation")
    expect(await run(["git", "status", "--porcelain=v1"], path.join(workarea, "remediation", "checkout"))).toBe("")
  })

  test("accepts model-selected oracle commands and exit semantics", async () => {
    const sessionID = "ses_test_contract"
    const findingID = "finding-1"
    const prepared = recordValue(
      await handleGitTool(sessionID, "remediation_prepare", { slug: "test-contract" }, hooks),
      "test-contract remediation preparation",
    )
    const preFix = recordValue(
      await handleGitTool(
        sessionID,
        "remediation_test",
        {
          command: ["true"],
          stage: "pre-fix",
          test_case: "finding-1-reproduction",
          finding_ids: [findingID],
          expected_exit_codes: [0],
        },
        hooks,
      ),
      "pre-fix remediation test",
    )
    expect(preFix).toMatchObject({ exit_code: 0, expectation_met: true })

    await writeFile(
      path.join(workarea, stringValue(prepared.checkout, "test-contract remediation checkout"), "service.ts"),
      "export const value = safe(input)\n",
    )
    const postFix = recordValue(
      await handleGitTool(
        sessionID,
        "remediation_test",
        {
          command: ["false"],
          stage: "post-fix",
          test_case: "finding-1-reproduction",
          finding_ids: [findingID],
          expected_exit_codes: [1],
        },
        hooks,
      ),
      "post-fix remediation test",
    )
    expect(postFix).toMatchObject({ exit_code: 1, expectation_met: true })
    expect(await authorizeFixedFinding(sessionID, findingID)).toEqual({ ok: true })
  })

  test("allows a different post-fix harness but preserves named case and finding binding", async () => {
    const sessionID = "ses_case_continuity"
    const findingID = "finding-case-continuity"
    const prepared = recordValue(
      await handleGitTool(sessionID, "remediation_prepare", { slug: "case-continuity" }, hooks),
      "case-continuity remediation preparation",
    )
    await handleGitTool(
      sessionID,
      "remediation_test",
      {
        command: ["remediation-case", "/workspace/remediation/checkout"],
        stage: "pre-fix",
        test_case: "service-input-is-sanitized",
        finding_ids: [findingID],
        expected_exit_codes: [1],
      },
      hooks,
    )
    await writeFile(
      path.join(workarea, stringValue(prepared.checkout, "case-continuity remediation checkout"), "service.ts"),
      "export const value = safe(input)\n",
    )

    await expect(
      handleGitTool(
        sessionID,
        "remediation_test",
        {
          command: ["remediation-case", "/workspace/remediation/checkout/."],
          stage: "post-fix",
          test_case: "different-vulnerable-case",
          finding_ids: [findingID],
          expected_exit_codes: [0],
        },
        hooks,
      ),
    ).rejects.toThrow("same named case")
    await expect(
      handleGitTool(
        sessionID,
        "remediation_test",
        {
          command: ["remediation-case", "/workspace/remediation/checkout/."],
          stage: "post-fix",
          test_case: "service-input-is-sanitized",
          finding_ids: ["different-finding"],
          expected_exit_codes: [0],
        },
        hooks,
      ),
    ).rejects.toThrow("same named case and finding set")
    await handleGitTool(
      sessionID,
      "remediation_test",
      {
        command: ["true"],
        stage: "post-fix",
        test_case: "service-input-is-sanitized",
        finding_ids: [findingID],
        expected_exit_codes: [0],
      },
      hooks,
    )
    expect(await authorizeFixedFinding(sessionID, findingID)).toEqual({ ok: true })
  })

  test("authorizes fixed status only from signed pre-fix and current-tree post-fix proofs", async () => {
    const sessionID = "ses_fixed_authorization"
    const findingID = "finding-authorization"
    const prepared = recordValue(
      await handleGitTool(sessionID, "remediation_prepare", { slug: "authorization" }, hooks),
      "authorization remediation preparation",
    )
    await handleGitTool(
      sessionID,
      "remediation_test",
      {
        command: ["remediation-case", "/workspace/remediation/checkout"],
        stage: "pre-fix",
        test_case: "service-input-is-sanitized",
        finding_ids: [findingID],
        expected_exit_codes: [1],
      },
      hooks,
    )
    expect(await authorizeFixedFinding(sessionID, findingID)).toMatchObject({ ok: false })

    const checkout = path.join(workarea, stringValue(prepared.checkout, "authorization remediation checkout"))
    await writeFile(path.join(checkout, "service.ts"), "export const value = safe(input)\n")
    await handleGitTool(
      sessionID,
      "remediation_test",
      {
        command: ["remediation-case", "/workspace/remediation/checkout/."],
        stage: "post-fix",
        test_case: "service-input-is-sanitized",
        finding_ids: [findingID],
        expected_exit_codes: [0],
      },
      hooks,
    )
    const statusBefore = await run(["git", "status", "--porcelain=v1"], checkout)
    expect(await authorizeFixedFinding(sessionID, findingID)).toEqual({ ok: true })
    expect(await run(["git", "status", "--porcelain=v1"], checkout)).toBe(statusBefore)
    expect(statusBefore).toBe("M service.ts")
    expect(await run(["git", "diff", "--cached", "--name-only"], checkout)).toBe("")

    await writeFile(path.join(checkout, "service.ts"), "export const value = differentlySafe(input)\n")
    expect(await authorizeFixedFinding(sessionID, findingID)).toMatchObject({ ok: false })
  })

  test("binds consent to exact proofs, findings, files, patch digest, and remote URL", async () => {
    const sessionID = "ses_publish_candidate"
    const findingID = "finding-candidate"
    const remote = path.join(root, "remote.git")
    await run(["git", "init", "--bare", remote], root)
    await run(["git", "remote", "add", "origin", remote])
    await prepareVerifiedRemediation(sessionID, findingID)
    let candidate: PublishCandidate | undefined
    const publishingHooks: GitToolHooks = {
      fixedFindings: hooks.fixedFindings,
      confirmPublish: async (value) => {
        candidate = value
        return true
      },
    }
    const result = recordValue(
      await handleGitTool(
        sessionID,
        "remediation_publish",
        { title: "Fix candidate", commit_message: "fix: candidate", finding_ids: [findingID] },
        publishingHooks,
      ),
      "candidate remediation publication",
    )

    expect(candidate).toBeDefined()
    if (!candidate) throw new Error("publish confirmation did not receive the expected candidate")
    const acceptedCandidate = candidate
    expect(acceptedCandidate.remoteURL).toBe(remote)
    expect(acceptedCandidate.findingIDs).toEqual([findingID])
    expect(acceptedCandidate.changedFiles).toEqual(["service.ts"])
    expect(acceptedCandidate.proofs.map((proof) => proof.stage).sort()).toEqual(["post-fix", "pre-fix"])
    expect(new Set(acceptedCandidate.proofs.map((proof) => proof.commandSha256)).size).toBe(2)
    expect(new Set(acceptedCandidate.proofs.map((proof) => proof.commandIdentitySha256)).size).toBe(1)
    expect(new Set(acceptedCandidate.proofs.map((proof) => proof.caseSha256)).size).toBe(1)
    expect(
      acceptedCandidate.proofs.every((proof) => proof.findingIDs.length === 1 && proof.findingIDs[0] === findingID),
    ).toBe(true)
    const patch = await readFile(path.join(workarea, "reports", "remediation.patch"), "utf8")
    expect(acceptedCandidate.patch).toEqual({
      path: "reports/remediation.patch",
      sha256: createHash("sha256").update(patch).digest("hex"),
      bytes: Buffer.byteLength(patch),
    })
    expect(result).toMatchObject({ published: true, branchPushed: true, reviewCreated: false, provider: "git" })
    expect(await run(["git", "--git-dir", remote, "rev-parse", `refs/heads/${acceptedCandidate.branch}`], root)).toBe(
      acceptedCandidate.commit,
    )
  })

  test("commits an imported-style repository without relying on global Git identity", async () => {
    const sessionID = "ses_publish_identity"
    const findingID = "finding-identity"
    const checkout = await prepareVerifiedRemediation(sessionID, findingID)
    await run(["git", "config", "--unset", "user.name"])
    await run(["git", "config", "--unset", "user.email"])

    const result = recordValue(
      await handleGitTool(
        sessionID,
        "remediation_publish",
        { title: "Fix identity", commit_message: "fix: identity", finding_ids: [findingID] },
        hooks,
      ),
      "identity remediation publication",
    )

    expect(result).toMatchObject({ published: false, branchPushed: false, reviewCreated: false })
    expect(await run(["git", "show", "-s", "--format=%an <%ae>", "HEAD"], checkout)).toBe(
      "Cyberful <cyberful@localhost>",
    )
  })

  test("records adapter failure after a successful push without claiming a review was created", async () => {
    const sessionID = "ses_publish_adapter"
    const findingID = "finding-adapter"
    await run(["git", "remote", "add", "origin", "https://github.com/example/security-project.git"])
    await prepareVerifiedRemediation(sessionID, findingID)

    const realGit = await run(["which", "git"], root)
    await writeFile(
      path.join(testBin, "git"),
      [
        "#!/bin/sh",
        'for argument in "$@"; do',
        '  if [ "$argument" = "push" ]; then exit 0; fi',
        "done",
        `exec "${realGit.replaceAll('"', '\\"')}" "$@"`,
        "",
      ].join("\n"),
    )
    await writeFile(
      path.join(testBin, "gh"),
      ["#!/bin/sh", 'if [ "${1:-}" = "--version" ]; then exit 0; fi', 'echo "adapter failed" >&2', "exit 7", ""].join(
        "\n",
      ),
    )
    await Promise.all([chmod(path.join(testBin, "git"), 0o700), chmod(path.join(testBin, "gh"), 0o700)])

    let candidate: PublishCandidate | undefined
    const result = recordValue(
      await handleGitTool(
        sessionID,
        "remediation_publish",
        { title: "Fix adapter", commit_message: "fix: adapter", finding_ids: [findingID] },
        {
          fixedFindings: hooks.fixedFindings,
          confirmPublish: async (value) => {
            candidate = value
            return true
          },
        },
      ),
      "adapter remediation publication",
    )
    expect(candidate).toMatchObject({
      provider: "github",
      remoteURL: "https://github.com/example/security-project.git",
    })
    expect(result).toMatchObject({
      published: true,
      branchPushed: true,
      reviewCreated: false,
      provider: "github",
      adapter_exit_code: 7,
      adapterError: "adapter failed",
    })
  })
})
