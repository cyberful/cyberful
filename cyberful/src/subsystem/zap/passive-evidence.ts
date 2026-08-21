// ── Host-Owned Passive ZAP Evidence ─────────────────────────────
// Captures filtered passive-scan evidence after an accepted live-target phase
//   without promoting scanner alerts to findings or blocking phase advancement.
// → cyberful/src/subsystem/engagement-runtime.ts — supplies the private ZAP bridge.
// → cyberful/src/subsystem/phase-runner.ts — invokes the accepted-phase checkpoint.
// @docs/runtimes/zap.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { lstat, readFile, rm } from "node:fs/promises"
import { appendWorkareaFile, replaceWorkareaFile } from "@/workarea"
import {
  httpHostIsAuthorized,
  readEngagementPolicy,
} from "../gateway/engagement-policy"

export const PASSIVE_EVIDENCE_POLL_INTERVAL_MS = 500
export const PASSIVE_EVIDENCE_QUEUE_TIMEOUT_MS = 10_000
export const PASSIVE_EVIDENCE_REPORT_BATCH_SIZE = 100
const PASSIVE_EVIDENCE_MAX_REPORT_BYTES = 100 * 1024 * 1024
const PASSIVE_EVIDENCE_LEDGER = "raw/operations/zap-passive-evidence.jsonl"

export type PassiveEvidenceState =
  | "complete"
  | "partial"
  | "failed"
  | "not_applicable"
  | "no_observed_traffic"

export interface PassiveEvidenceReport {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly sites: readonly string[]
}

export interface PassiveEvidenceManifest {
  readonly version: 1
  readonly workflow: "pentest" | "bug-bounty"
  readonly phase: string
  readonly attempt: number
  readonly timestamp: string
  readonly state: PassiveEvidenceState
  readonly authorized_http_hosts: readonly string[]
  readonly observed_origins: readonly string[]
  readonly queue: {
    readonly initial: number | null
    readonly final: number | null
    readonly waited_ms: number
    readonly drained: boolean | null
  }
  readonly reports: readonly PassiveEvidenceReport[]
  readonly errors?: readonly string[]
}

export interface PassiveEvidenceCapture {
  readonly state: PassiveEvidenceState
  readonly manifest?: string
  readonly warning?: string
}

export interface PassiveEvidenceSource {
  readonly sites: () => Promise<readonly string[]>
  readonly queueDepth: () => Promise<number>
  readonly generateReport: (input: {
    readonly filePath: string
    readonly sites: readonly string[]
    readonly title: string
  }) => Promise<void>
  readonly close: () => Promise<void>
}

export interface PassiveEvidenceDependencies {
  readonly openSource: () => Promise<PassiveEvidenceSource>
  readonly now?: () => number
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

export interface PassiveEvidenceInput {
  readonly workarea: string
  readonly workflow: "pentest" | "bug-bounty"
  readonly phase: string
  readonly attempt: number
  readonly signal?: AbortSignal
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function boundedError(error: unknown) {
  return errorMessage(error).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500)
}

function defaultSleep(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }
    const timeout = setTimeout(finish, milliseconds)
    const abort = () => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
      reject(signal?.reason ?? new Error("Passive evidence capture aborted"))
    }
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
  })
}

export function normalizedHttpOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

export function authorizedObservedOrigins(sites: readonly string[], authorizedHosts: readonly string[]) {
  return [...new Set(sites.map(normalizedHttpOrigin).filter((origin): origin is string => origin !== undefined))]
    .filter((origin) => httpHostIsAuthorized(new URL(origin).hostname, authorizedHosts))
    .sort()
}

function chunks<T>(values: readonly T[], size: number) {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

function reportSites(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("site" in value))
    throw new Error("traditional-json report has no site collection")
  const sites = (value as { site?: unknown }).site
  if (!Array.isArray(sites)) throw new Error("traditional-json report site collection is invalid")
  return sites.map((site, index) => {
    if (typeof site !== "object" || site === null || Array.isArray(site))
      throw new Error(`traditional-json report site[${index}] is invalid`)
    const name = (site as Record<string, unknown>)["@name"]
    if (typeof name !== "string") throw new Error(`traditional-json report site[${index}] has no name`)
    const origin = normalizedHttpOrigin(name)
    if (!origin) throw new Error(`traditional-json report site[${index}] is not HTTP(S)`)
    return origin
  })
}

function sanitizedReportBytes(
  value: unknown,
  requestedSites: ReadonlySet<string>,
  authorizedHosts: readonly string[],
) {
  const sites = reportSites(value)
  if (sites.some((site) => !httpHostIsAuthorized(new URL(site).hostname, authorizedHosts)))
    throw new Error("generated report contains an unauthorized site")
  if (sites.some((site) => !requestedSites.has(site)))
    throw new Error("generated report contains a site outside its batch")

  const report = value as Record<string, unknown>
  if (report.insights !== undefined) {
    if (!Array.isArray(report.insights)) throw new Error("traditional-json report insights collection is invalid")
    report.insights = report.insights.filter((insight, index) => {
      if (typeof insight !== "object" || insight === null || Array.isArray(insight))
        throw new Error(`traditional-json report insight[${index}] is invalid`)
      const site = (insight as Record<string, unknown>).site
      if (site === "" || site === undefined) return true
      if (typeof site !== "string") throw new Error(`traditional-json report insight[${index}] site is invalid`)
      const origin = normalizedHttpOrigin(site)
      if (!origin) throw new Error(`traditional-json report insight[${index}] site is not HTTP(S)`)
      return requestedSites.has(origin) && httpHostIsAuthorized(new URL(origin).hostname, authorizedHosts)
    })
  }
  return { bytes: Buffer.from(`${JSON.stringify(report, null, 2)}\n`), sites }
}

function manifestPath(input: PassiveEvidenceInput) {
  return `raw/zap/passive/${input.workflow}/${input.phase}.json`
}

async function publishManifest(input: PassiveEvidenceInput, manifest: PassiveEvidenceManifest) {
  const relativePath = manifestPath(input)
  await replaceWorkareaFile(input.workarea, relativePath, `${JSON.stringify(manifest, null, 2)}\n`)
  await appendWorkareaFile(
    input.workarea,
    PASSIVE_EVIDENCE_LEDGER,
    `${JSON.stringify({ ...manifest, manifest: relativePath })}\n`,
  )
  return relativePath
}

function baseManifest(
  input: PassiveEvidenceInput,
  timestamp: string,
  state: PassiveEvidenceState,
  authorizedHosts: readonly string[],
  observedOrigins: readonly string[],
  queue: PassiveEvidenceManifest["queue"],
  reports: readonly PassiveEvidenceReport[],
  errors: readonly string[] = [],
): PassiveEvidenceManifest {
  return {
    version: 1,
    workflow: input.workflow,
    phase: input.phase,
    attempt: input.attempt,
    timestamp,
    state,
    authorized_http_hosts: authorizedHosts,
    observed_origins: observedOrigins,
    queue,
    reports,
    ...(errors.length > 0 ? { errors } : {}),
  }
}

async function publishTerminal(
  input: PassiveEvidenceInput,
  manifest: PassiveEvidenceManifest,
): Promise<PassiveEvidenceCapture> {
  try {
    return { state: manifest.state, manifest: await publishManifest(input, manifest) }
  } catch (error) {
    return {
      state: "failed",
      warning: `OWASP ZAP passive evidence storage failed after ${input.phase}: ${boundedError(error)}`,
    }
  }
}

async function publishReportObject(
  input: PassiveEvidenceInput,
  temporaryPath: string,
  requestedSites: readonly string[],
  authorizedHosts: readonly string[],
): Promise<PassiveEvidenceReport> {
  const absolutePath = path.join(input.workarea, temporaryPath)
  const entry = await lstat(absolutePath)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("generated report is not a regular file")
  if (entry.size > PASSIVE_EVIDENCE_MAX_REPORT_BYTES)
    throw new Error(`generated report exceeds ${PASSIVE_EVIDENCE_MAX_REPORT_BYTES} bytes`)
  const requested = new Set(requestedSites)
  const rawBytes = await readFile(absolutePath)
  const { bytes, sites } = sanitizedReportBytes(JSON.parse(rawBytes.toString("utf8")), requested, authorizedHosts)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const objectPath = `raw/zap/passive/objects/${sha256}.json`
  await replaceWorkareaFile(input.workarea, objectPath, bytes)
  return { path: objectPath, sha256, bytes: bytes.byteLength, sites }
}

// ── Scope Is Resolved Before Any ZAP Operation ──────────────────
// Empty finalized HTTP scope produces a manifest without opening the bridge.
// A single site-tree read then decides whether queue polling and report work are
// applicable. Every later failure is evidence degradation, never a handoff gate.
// Report batches retain exact origins so a port can partition evidence without
// turning that port, a path, or credentials into a broader authorization rule.
// ─────────────────────────────────────────────────────────────────

export async function capturePassiveEvidence(
  input: PassiveEvidenceInput,
  dependencies: PassiveEvidenceDependencies,
): Promise<PassiveEvidenceCapture> {
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? defaultSleep
  const timestamp = new Date(now()).toISOString()
  let authorizedHosts: readonly string[] = []
  let observedOrigins: readonly string[] = []
  let queue: PassiveEvidenceManifest["queue"] = {
    initial: null,
    final: null,
    waited_ms: 0,
    drained: null,
  }
  const reports: PassiveEvidenceReport[] = []
  const errors: string[] = []
  let source: PassiveEvidenceSource | undefined

  try {
    const policy = await readEngagementPolicy(input.workarea)
    if (!policy || policy.stage !== "final") throw new Error("final engagement policy is unavailable")
    authorizedHosts = [...policy.authorized_http_hosts]
    if (authorizedHosts.length === 0)
      return publishTerminal(
        input,
        baseManifest(input, timestamp, "not_applicable", authorizedHosts, [], queue, []),
      )

    source = await dependencies.openSource()
    observedOrigins = authorizedObservedOrigins(await source.sites(), authorizedHosts)
    if (observedOrigins.length === 0)
      return publishTerminal(
        input,
        baseManifest(input, timestamp, "no_observed_traffic", authorizedHosts, [], queue, []),
      )

    const initial = await source.queueDepth()
    if (!Number.isSafeInteger(initial) || initial < 0) throw new Error("ZAP passive queue depth is invalid")
    let final = initial
    let waitedMs = 0
    while (final > 0 && waitedMs < PASSIVE_EVIDENCE_QUEUE_TIMEOUT_MS) {
      const delay = Math.min(PASSIVE_EVIDENCE_POLL_INTERVAL_MS, PASSIVE_EVIDENCE_QUEUE_TIMEOUT_MS - waitedMs)
      await sleep(delay, input.signal)
      waitedMs += delay
      final = await source.queueDepth()
      if (!Number.isSafeInteger(final) || final < 0) throw new Error("ZAP passive queue depth is invalid")
    }
    queue = { initial, final, waited_ms: waitedMs, drained: final === 0 }

    for (const [index, sites] of chunks(observedOrigins, PASSIVE_EVIDENCE_REPORT_BATCH_SIZE).entries()) {
      const temporaryPath = `raw/zap/passive/.tmp/${input.workflow}-${input.phase}-${input.attempt}-${index}-${randomUUID()}.json`
      try {
        await source.generateReport({
          filePath: temporaryPath,
          sites,
          title: `Cyberful passive evidence: ${input.workflow}/${input.phase} attempt ${input.attempt}`,
        })
        reports.push(await publishReportObject(input, temporaryPath, sites, authorizedHosts))
      } catch (error) {
        errors.push(`batch ${index + 1}: ${boundedError(error)}`)
      } finally {
        await rm(path.join(input.workarea, temporaryPath), { force: true }).catch(() => undefined)
      }
    }

    const state: PassiveEvidenceState = reports.length === 0
      ? "failed"
      : queue.drained && errors.length === 0
        ? "complete"
        : "partial"
    const manifest = baseManifest(input, timestamp, state, authorizedHosts, observedOrigins, queue, reports, errors)
    const published = await publishTerminal(input, manifest)
    if (published.state === "failed" && published.warning) return published
    return state === "partial" || state === "failed"
      ? {
          ...published,
          warning: `OWASP ZAP passive evidence after ${input.phase} is ${state}; phase advancement is unchanged.`,
        }
      : published
  } catch (error) {
    errors.push(boundedError(error))
    const manifest = baseManifest(input, timestamp, "failed", authorizedHosts, observedOrigins, queue, reports, errors)
    const published = await publishTerminal(input, manifest)
    return {
      ...published,
      state: "failed",
      warning: `OWASP ZAP passive evidence failed after ${input.phase}; phase advancement is unchanged: ${boundedError(error)}`,
    }
  } finally {
    await source?.close().catch(() => undefined)
  }
}

export * as SubsystemZapPassiveEvidence from "./passive-evidence"
