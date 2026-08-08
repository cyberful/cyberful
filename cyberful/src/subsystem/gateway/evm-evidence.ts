// ── Explicit EVM Finding Evidence ───────────────────────────────────────────
// Registers only model-selected candidate-finding artifacts. Generic stdout and
// ordinary Cast traffic are intentionally absent; each record binds one existing
// workarea file to reproducible command and immutable source/lab provenance.
// @docs/runtimes/evm.md
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises"
import { replaceWorkareaFile } from "@/workarea"
import { dockerCommand } from "../evm/runtime"
import { listVerifiedSourceImports } from "./source-import"

const INDEX_PATH = "raw/evm/evidence.json"
const LAB_PATH = "raw/evm/lab.json"
const MAX_EVIDENCE = 1_000
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
const MAX_BUILD_INFO_BYTES = 64 * 1024 * 1024
const MAX_BUILD_INFO_FILES = 100
const KINDS = ["test", "trace", "state-diff", "fuzz", "invariant", "poc"] as const

export const EVM_EVIDENCE_TOOL_DEF = {
  name: "evm_evidence",
  description:
    "Record or list concise, reproducible EVM evidence for candidate findings. Recording hashes one existing workarea artifact; generic stdout and routine Cast calls are never captured automatically.",
  inputSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["record", "list"] },
      kind: { type: "string", enum: KINDS },
      artifact: { type: "string", minLength: 1, maxLength: 1_024 },
      command: { type: "string", minLength: 1, maxLength: 8_192 },
      repository: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
      solidity: { type: "string", minLength: 1, maxLength: 100 },
      build_info: {
        type: "string",
        minLength: 1,
        maxLength: 1_024,
        description: "Optional Foundry build-info JSON path relative to the selected materialized repository.",
      },
      seed: { anyOf: [{ type: "string", maxLength: 200 }, { type: "integer" }] },
      runs: { type: "integer", minimum: 1, maximum: 100_000_000 },
      transaction_hash: { type: "string", pattern: "^0x[a-fA-F0-9]{64}$" },
      note: { type: "string", maxLength: 2_000 },
    },
    required: ["action"],
  },
} as const

interface EvidenceIndex {
  readonly version: 1
  readonly evidence: readonly Record<string, unknown>[]
}

interface EvmEvidenceHooks {
  readonly docker?: typeof dockerCommand
}

interface LabContext {
  readonly lab_id?: string
  readonly chain_id?: number
  readonly fork_block?: number
  readonly repositories: readonly { readonly repository: string; readonly project_path: string }[]
}

function workareaRoot() {
  const configured = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim()
  if (!configured || !path.isAbsolute(configured)) throw new Error("evm_evidence requires an absolute workarea")
  return configured
}

function contained(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function safeRegularFile(root: string, value: unknown, label: string, maximumBytes: number) {
  if (typeof value !== "string" || !value || value.length > 1_024 || value.includes("\0") || path.isAbsolute(value))
    throw new Error(`${label} must be a relative path`)
  const relative = path.normalize(value)
  if (relative.split(path.sep).some((segment) => segment === ".." || segment === "."))
    throw new Error(`${label} escapes its root`)
  let cursor = root
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment)
    const metadata = await lstat(cursor)
    if (metadata.isSymbolicLink()) throw new Error(`${label} path contains a symlink`)
  }
  const canonical = await realpath(cursor)
  if (!contained(root, canonical)) throw new Error(`${label} escapes its root`)
  const metadata = await lstat(canonical)
  if (!metadata.isFile() || metadata.size > maximumBytes)
    throw new Error(`${label} must be a regular file within the size limit`)
  return { absolute: canonical, relative: path.relative(root, canonical).replaceAll(path.sep, "/") }
}

async function safeArtifact(workarea: string, value: unknown) {
  return safeRegularFile(workarea, value, "evm_evidence artifact", MAX_ARTIFACT_BYTES)
}

async function artifactHash(filename: string) {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const digest = createHash("sha256")
  let size = 0
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024)
    while (true) {
      const result = await handle.read(chunk, 0, chunk.byteLength, size)
      if (result.bytesRead === 0) break
      digest.update(chunk.subarray(0, result.bytesRead))
      size += result.bytesRead
    }
    const final = await handle.stat()
    if (!final.isFile() || final.size !== size) throw new Error("evm_evidence artifact changed while hashing")
  } finally {
    await handle.close()
  }
  return { sha256: digest.digest("hex"), bytes: size }
}

// ── Evidence Names The Toolchain That Actually Produced It ─────────────────
// A caller-supplied compiler string is useful as an expected value but cannot
// establish provenance. The selected build-info must remain inside the mutable
// materialized project, while the Forge binary and image identity must come from
// the running engagement-owned core container. A mismatch fails before indexing.
// ─────────────────────────────────────────────────────────────────────────────

async function projectRoot(workarea: string, lab: LabContext, repository: string) {
  const selected = lab.repositories.find((candidate) => candidate.repository === repository)
  if (!selected) throw new Error(`EVM lab has no materialized project for repository '${repository}'`)
  const normalized = path.normalize(selected.project_path)
  if (
    path.isAbsolute(normalized) ||
    normalized.split(path.sep).some((segment) => segment === ".." || segment === ".")
  )
    throw new Error("EVM lab project path is unsafe")
  let cursor = workarea
  for (const segment of normalized.split(path.sep)) {
    cursor = path.join(cursor, segment)
    const metadata = await lstat(cursor)
    if (metadata.isSymbolicLink()) throw new Error("EVM lab project path contains a symlink")
  }
  const canonical = await realpath(cursor)
  const metadata = await lstat(canonical)
  if (!contained(workarea, canonical) || !metadata.isDirectory()) throw new Error("EVM lab project path is unsafe")
  return canonical
}

async function selectBuildInfo(project: string, value: unknown) {
  if (value !== undefined) return safeRegularFile(project, value, "evm_evidence build_info", MAX_BUILD_INFO_BYTES)
  const directory = path.join(project, "out", "build-info")
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  const names = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .toSorted()
  if (names.length === 0) throw new Error("evm_evidence found no Foundry build-info; pass build_info explicitly")
  if (names.length > MAX_BUILD_INFO_FILES) throw new Error("evm_evidence found too many Foundry build-info files")
  if (names.length !== 1) throw new Error("evm_evidence found multiple Foundry build-info files; pass build_info explicitly")
  return safeRegularFile(project, path.join("out", "build-info", names[0] ?? ""), "evm_evidence build_info", MAX_BUILD_INFO_BYTES)
}

async function parseBuildInfo(filename: string) {
  const parsed: unknown = JSON.parse(await readFile(filename, "utf8"))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("evm_evidence build_info is malformed")
  const value = parsed as Record<string, unknown>
  if (
    value._format !== "ethers-rs-sol-build-info-1" ||
    value.language !== "Solidity" ||
    typeof value.solcVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.solcVersion) ||
    typeof value.solcLongVersion !== "string" ||
    (value.solcLongVersion !== value.solcVersion && !value.solcLongVersion.startsWith(`${value.solcVersion}+`)) ||
    !value.input ||
    typeof value.input !== "object" ||
    Array.isArray(value.input) ||
    !value.output ||
    typeof value.output !== "object" ||
    Array.isArray(value.output)
  )
    throw new Error("evm_evidence build_info is not a supported Foundry Solidity build")
  return {
    format: value._format,
    solidity: value.solcVersion,
    solidity_long: value.solcLongVersion,
  }
}

async function liveFoundryAttestation(docker: typeof dockerCommand) {
  const container = process.env.CYBERFUL_OS_CONTAINER?.trim()
  if (!container || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container))
    throw new Error("evm_evidence requires the engagement-owned cyberful-os container")
  const inspected = await docker([
    "inspect",
    "--format",
    '{{.State.Running}} {{index .Config.Labels "org.cyberful.managed"}} {{index .Config.Labels "org.cyberful.runtime"}} {{.Image}}',
    container,
  ])
  if (inspected.exitCode !== 0)
    throw new Error(`evm_evidence could not inspect cyberful-os: ${inspected.stderr.trim()}`)
  const [running, managed, runtime, image] = inspected.stdout.trim().split(/\s+/, 4)
  if (running !== "true" || managed !== "engagement" || runtime !== "cyberful-os" || !/^sha256:[a-f0-9]{64}$/.test(image ?? ""))
    throw new Error("evm_evidence rejected an unattested cyberful-os container")
  const version = await docker(["exec", container, "forge", "--version"])
  if (version.exitCode !== 0) throw new Error(`evm_evidence could not attest Forge: ${version.stderr.trim()}`)
  const release = /^forge Version: ([0-9]+\.[0-9]+\.[0-9]+)$/m.exec(version.stdout)?.[1]
  const commit = /^Commit SHA: ([a-f0-9]{40})$/m.exec(version.stdout)?.[1]
  if (!release || !commit) throw new Error("evm_evidence received malformed Forge version evidence")
  return { foundry: `v${release}`, foundry_commit: commit, image_id: image ?? "" }
}

async function readIndex(workarea: string): Promise<EvidenceIndex> {
  const filename = path.join(workarea, INDEX_PATH)
  const metadata = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!metadata) return { version: 1, evidence: [] }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024)
    throw new Error("EVM evidence index is unsafe")
  const parsed: unknown = JSON.parse(await readFile(filename, "utf8"))
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("evidence" in parsed) ||
    !Array.isArray(parsed.evidence) ||
    parsed.evidence.length > MAX_EVIDENCE
  )
    throw new Error("EVM evidence index is malformed")
  return parsed as EvidenceIndex
}

async function labContext(workarea: string): Promise<LabContext> {
  const filename = path.join(workarea, LAB_PATH)
  const metadata = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024)
    throw new Error("evm_evidence requires a safe EVM lab state")
  const parsed: unknown = JSON.parse(await readFile(filename, "utf8"))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("EVM lab state is malformed")
  const value = parsed as Record<string, unknown>
  const repositories = Array.isArray(value.repositories)
    ? value.repositories.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("EVM lab repository state is malformed")
        const repository = "repository" in item ? item.repository : undefined
        const projectPath = "project_path" in item ? item.project_path : undefined
        if (
          typeof repository !== "string" ||
          !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(repository) ||
          typeof projectPath !== "string" ||
          !projectPath
        )
          throw new Error("EVM lab repository state is malformed")
        return { repository, project_path: projectPath }
      })
    : []
  return {
    lab_id: typeof value.lab_id === "string" ? value.lab_id : undefined,
    chain_id: typeof value.chain_id === "number" ? value.chain_id : undefined,
    fork_block:
      value.fork && typeof value.fork === "object" && "block" in value.fork && typeof value.fork.block === "number"
        ? value.fork.block
        : undefined,
    repositories,
  }
}

async function repositoryContext(repository: unknown) {
  if (typeof repository !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(repository))
    throw new Error("evm_evidence record requires a repository alias")
  const store = process.env.CYBERFUL_SOURCE_STORE_ROOT?.trim()
  if (!store || !path.isAbsolute(store)) throw new Error("evm_evidence requires the host source collection")
  const imported = (await listVerifiedSourceImports(store)).find((entry) => entry.repository === repository)
  if (!imported) throw new Error(`source repository '${repository}' is not imported`)
  return { repository, commit: imported.manifest.commit }
}

export function evmEvidenceAvailable() {
  return Boolean(
    process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim() && process.env.CYBERFUL_SOURCE_STORE_ROOT?.trim(),
  )
}

export async function handleEvmEvidence(args: Record<string, unknown>, hooks: EvmEvidenceHooks = {}) {
  const workarea = await realpath(workareaRoot())
  const index = await readIndex(workarea)
  if (args.action === "list") return index
  if (args.action !== "record") throw new Error("evm_evidence action must be record or list")
  if (!KINDS.includes(args.kind as (typeof KINDS)[number]))
    throw new Error(`evm_evidence kind must be one of ${KINDS.join(", ")}`)
  if (typeof args.command !== "string" || !args.command.trim() || args.command.length > 8_192)
    throw new Error("evm_evidence record requires a bounded repeatable command")
  if (typeof args.solidity !== "string" || !args.solidity.trim() || args.solidity.length > 100)
    throw new Error("evm_evidence record requires the Solidity compiler version")
  if (args.build_info !== undefined && (typeof args.build_info !== "string" || !args.build_info || args.build_info.length > 1_024))
    throw new Error("evm_evidence build_info must be a bounded relative path")
  if (args.runs !== undefined && (!Number.isSafeInteger(args.runs) || Number(args.runs) < 1 || Number(args.runs) > 100_000_000))
    throw new Error("evm_evidence runs must be an integer from 1 to 100000000")
  if (args.transaction_hash !== undefined && (typeof args.transaction_hash !== "string" || !/^0x[a-f0-9]{64}$/i.test(args.transaction_hash)))
    throw new Error("evm_evidence transaction_hash must be a 32-byte hex hash")
  if (args.note !== undefined && (typeof args.note !== "string" || args.note.length > 2_000))
    throw new Error("evm_evidence note must contain at most 2000 characters")
  if (index.evidence.length >= MAX_EVIDENCE) throw new Error(`evm_evidence supports at most ${MAX_EVIDENCE} records`)

  const artifact = await safeArtifact(workarea, args.artifact)
  const [hash, source, lab] = await Promise.all([
    artifactHash(artifact.absolute),
    repositoryContext(args.repository),
    labContext(workarea),
  ])
  const project = await projectRoot(workarea, lab, source.repository)
  const buildInfo = await selectBuildInfo(project, args.build_info)
  const [buildInfoHash, compiler] = await Promise.all([
    artifactHash(buildInfo.absolute),
    parseBuildInfo(buildInfo.absolute),
  ])
  const expectedSolidity = args.solidity.trim().replace(/^v/, "")
  if (expectedSolidity !== compiler.solidity)
    throw new Error(
      `evm_evidence Solidity version mismatch: expected ${expectedSolidity}, build-info uses ${compiler.solidity}`,
    )
  const liveToolchain = await liveFoundryAttestation(hooks.docker ?? dockerCommand)
  const labEvidence = {
    lab_id: lab.lab_id,
    chain_id: lab.chain_id,
    fork_block: lab.fork_block,
  }
  const record = {
    id: `evm-${randomUUID()}`,
    kind: args.kind,
    command: args.command.trim(),
    ...(args.seed === undefined ? {} : { seed: args.seed }),
    ...(args.runs === undefined ? {} : { runs: args.runs }),
    artifact: { path: artifact.relative, ...hash },
    source,
    toolchain: {
      foundry: liveToolchain.foundry,
      solidity: compiler.solidity,
      attestation: {
        foundry_commit: liveToolchain.foundry_commit,
        image_id: liveToolchain.image_id,
        build_info: {
          path: path.relative(workarea, buildInfo.absolute).replaceAll(path.sep, "/"),
          sha256: buildInfoHash.sha256,
          bytes: buildInfoHash.bytes,
          format: compiler.format,
          solidity_long: compiler.solidity_long,
        },
      },
    },
    lab: labEvidence,
    ...(args.transaction_hash === undefined ? {} : { transaction_hash: args.transaction_hash.toLowerCase() }),
    ...(args.note === undefined || !args.note.trim() ? {} : { note: args.note.trim() }),
    recorded_at: new Date().toISOString(),
  }
  const next: EvidenceIndex = { version: 1, evidence: [...index.evidence, record] }
  await replaceWorkareaFile(workarea, INDEX_PATH, `${JSON.stringify(next, null, 2)}\n`)
  return { recorded: true, evidence: record, index_path: INDEX_PATH }
}
