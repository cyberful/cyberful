// ── Explicit EVM Finding Evidence ───────────────────────────────────────────
// Registers only model-selected candidate-finding artifacts. Generic stdout and
// ordinary Cast traffic are intentionally absent; each record binds one existing
// workarea file to reproducible command and immutable source/lab provenance.
// @docs/runtimes/evm.md
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readFile, realpath } from "node:fs/promises"
import { replaceWorkareaFile } from "@/workarea"
import { listVerifiedSourceImports } from "./source-import"

const INDEX_PATH = "raw/evm/evidence.json"
const LAB_PATH = "raw/evm/lab.json"
const MAX_EVIDENCE = 1_000
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
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

function workareaRoot() {
  const configured = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim()
  if (!configured || !path.isAbsolute(configured)) throw new Error("evm_evidence requires an absolute workarea")
  return configured
}

function contained(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function safeArtifact(workarea: string, value: unknown) {
  if (typeof value !== "string" || !value || value.length > 1_024 || value.includes("\0") || path.isAbsolute(value))
    throw new Error("evm_evidence artifact must be a relative workarea path")
  const relative = path.normalize(value)
  if (relative.split(path.sep).some((segment) => segment === ".." || segment === "."))
    throw new Error("evm_evidence artifact escapes the workarea")
  let cursor = workarea
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment)
    const metadata = await lstat(cursor)
    if (metadata.isSymbolicLink()) throw new Error("evm_evidence artifact path contains a symlink")
  }
  const canonical = await realpath(cursor)
  if (!contained(workarea, canonical)) throw new Error("evm_evidence artifact escapes the workarea")
  const metadata = await lstat(canonical)
  if (!metadata.isFile() || metadata.size > MAX_ARTIFACT_BYTES)
    throw new Error("evm_evidence artifact must be a regular file within the size limit")
  return { absolute: canonical, relative: path.relative(workarea, canonical).replaceAll(path.sep, "/") }
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

async function labContext(workarea: string) {
  const filename = path.join(workarea, LAB_PATH)
  const metadata = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) return
  const parsed: unknown = JSON.parse(await readFile(filename, "utf8"))
  if (!parsed || typeof parsed !== "object") return
  const value = parsed as Record<string, unknown>
  return {
    lab_id: typeof value.lab_id === "string" ? value.lab_id : undefined,
    chain_id: typeof value.chain_id === "number" ? value.chain_id : undefined,
    fork_block:
      value.fork && typeof value.fork === "object" && "block" in value.fork && typeof value.fork.block === "number"
        ? value.fork.block
        : undefined,
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

export async function handleEvmEvidence(args: Record<string, unknown>) {
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
  const record = {
    id: `evm-${randomUUID()}`,
    kind: args.kind,
    command: args.command.trim(),
    ...(args.seed === undefined ? {} : { seed: args.seed }),
    ...(args.runs === undefined ? {} : { runs: args.runs }),
    artifact: { path: artifact.relative, ...hash },
    source,
    toolchain: { foundry: "v1.7.1", solidity: args.solidity.trim() },
    ...(lab ? { lab } : {}),
    ...(args.transaction_hash === undefined ? {} : { transaction_hash: args.transaction_hash.toLowerCase() }),
    ...(args.note === undefined || !args.note.trim() ? {} : { note: args.note.trim() }),
    recorded_at: new Date().toISOString(),
  }
  const next: EvidenceIndex = { version: 1, evidence: [...index.evidence, record] }
  await replaceWorkareaFile(workarea, INDEX_PATH, `${JSON.stringify(next, null, 2)}\n`)
  return { recorded: true, evidence: record, index_path: INDEX_PATH }
}
