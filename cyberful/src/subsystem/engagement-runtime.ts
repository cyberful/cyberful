// ── Unified Engagement Runtime Ownership ─────────────────────────
// Starts the core tooling role plus a dedicated ZAP role, attests the core
//   platform, and owns both across gateways, recovery, and session cleanup.
// → cyberful/src/session/prompt.ts — scopes this owner to one workflow run.
// → mcps/cyberful-os/runtime_supervisor.py — supervises the in-container services.
// @docs/concepts/execution-model.md
// @docs/runtimes/cyberful-os.md
// ─────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  cyberGhidraBridgeCommand,
  cyberGhidraStartupTimeoutSeconds,
  cyberfulOsImage,
  cyberZapBridgeCommand,
  cyberZapMaxHistoryResponseBytes,
  cyberZapProxyPort,
  cyberZapStartupTimeoutSeconds,
  shouldChainBrowserThroughZap,
  shouldEnableCyberGhidra,
  shouldEnableCyberZap,
} from "@/dependency/config"
import { errorMessage } from "@/util/error"
import * as Log from "@/util/log"
import { Process } from "@/util/process"
import { BoundedByteTail } from "@/util/bounded-output"
import { dockerOwnershipLabels } from "@/util/container-ownership"
import { isRecord } from "@/util/record"
import { appendWorkareaFile, ensureWorkareaDirectory, replaceWorkareaFile } from "@/workarea"
import { SubsystemContainer } from "./container"
import {
  applyEngagementTrafficPolicy,
  engagementPolicyRequiresZap,
  readEngagementPolicy,
  type EngagementPolicy,
} from "./gateway/engagement-policy"
import {
  attestProxyCertificate,
  CORE_PROXY_CA_BUNDLE,
  CORE_PROXY_CA_CERTIFICATE,
  CORE_PROXY_TRUST_DIRECTORY,
  CORE_SYSTEM_CA_BUNDLE,
  localTargetWarning,
  parsePublishedPort,
  type ProxyCertificateAttestation,
} from "./zap/runtime"

const log = Log.create({ service: "engagement-runtime" })
const DOCKER_COMMAND_TIMEOUT_MS = 60_000
const DOCKER_OUTPUT_LIMIT_BYTES = 128 * 1024
const DOCKER_KILL_GRACE_MS = 1_000
const BRIDGE_PREFLIGHT_TIMEOUT_MS = 30_000
const BRIDGE_DIAGNOSTIC_LIMIT_BYTES = 64 * 1024
const REQUIRED_DOCKER_MEMORY_BYTES = 10_000_000_000
const ZAP_LIFECYCLE_PATH = "raw/operations/zap-runtime.jsonl"
const ZAP_RUNTIME_RELATIVE_PATH = "raw/zap/runtime"
const ZAP_TRUST_RELATIVE_PATH = "raw/zap/trust"
const ZAP_TRUST_ATTESTATION_FILE = "attestation.json"
const MAX_SYSTEM_CA_BUNDLE_BYTES = 2 * 1024 * 1024
const TLS_CANARY_PORT = 8443
const TLS_CANARY_TIMEOUT_MS = 20_000
const DOCKER_HOSTNAME_MAX_LENGTH = 63

export function dockerHostname(containerName: string): string {
  if (containerName.length <= DOCKER_HOSTNAME_MAX_LENGTH) return containerName
  const digest = createHash("sha256").update(containerName).digest("hex").slice(0, 24)
  return `${containerName.slice(0, DOCKER_HOSTNAME_MAX_LENGTH - digest.length - 1)}-${digest}`
}

export function dockerChildContainerName(parent: string, role: string): string {
  const candidate = `${parent}-${role}`
  if (candidate.length <= DOCKER_HOSTNAME_MAX_LENGTH) return candidate
  const digest = createHash("sha256").update(parent).update("\0").update(role).digest("hex").slice(0, 24)
  const prefixLength = DOCKER_HOSTNAME_MAX_LENGTH - digest.length - role.length - 2
  if (prefixLength < 1) throw new Error("Docker child container role is too long")
  return `${parent.slice(0, prefixLength)}-${digest}-${role}`
}

export function cyberfulOsRuntimePlatform(kernel: string, machine: string): string {
  const normalizedKernel = kernel.trim().toLowerCase()
  if (normalizedKernel !== "linux") throw new Error(`unsupported cyberful-os kernel: ${kernel.trim() || "<empty>"}`)
  const normalizedMachine = machine.trim().toLowerCase()
  if (normalizedMachine === "aarch64" || normalizedMachine === "arm64") return "Linux/ARM64 (aarch64)"
  if (normalizedMachine === "x86_64" || normalizedMachine === "amd64") return "Linux/AMD64 (x86_64)"
  throw new Error(`unsupported cyberful-os architecture: ${machine.trim() || "<empty>"}`)
}

export interface EngagementRuntime {
  readonly container: string
  readonly containers: readonly string[]
  readonly zapContainer?: string
  readonly env: Record<string, string>
  readonly degraded: boolean
  readonly warnings: readonly string[]
  readonly preparePhase: (input: {
    readonly phase: string
    readonly attempt: number
    readonly signal?: AbortSignal
  }) => Promise<{ readonly warnings: readonly string[]; readonly env: Readonly<Record<string, string>> }>
  readonly stop: () => Promise<void>
}

export type EngagementRuntimeServiceID = "cyber-os" | "zap" | "ghidra"
export type EngagementRuntimeServiceState = "pending" | "active" | "ready" | "degraded" | "failed"

export type EngagementRuntimeProgress = {
  readonly state: "active" | "ready" | "degraded" | "failed"
  readonly message: string
  readonly completed: number
  readonly total: number
  readonly services: readonly {
    readonly id: EngagementRuntimeServiceID
    readonly label: string
    readonly state: EngagementRuntimeServiceState
  }[]
}

export class RequiredUpstreamUnavailableError extends Error {
  readonly kind = "required_upstream_unavailable"
  readonly retryable = true

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "RequiredUpstreamUnavailableError"
  }
}

export function requiresZapUpstream(
  workflow: string,
  policy?: Partial<Pick<EngagementPolicy, "global_http_rps" | "required_http_headers">>,
) {
  return (
    workflow === "pentest" ||
    workflow === "bug-bounty" ||
    engagementPolicyRequiresZap(policy)
  )
}

type ZapAttestationStage = "api" | "ca" | "mcp" | "supervisor" | "tls_canary" | "traffic_policy"

class ZapAttestationStageError extends Error {
  readonly stage: ZapAttestationStage

  constructor(stage: ZapAttestationStage, cause: unknown) {
    super(`ZAP ${stage} attestation failed`, { cause })
    this.name = "ZapAttestationStageError"
    this.stage = stage
  }
}

interface DockerOptions {
  readonly env?: Record<string, string>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

interface BridgeProbeInput {
  readonly name: "zap" | "ghidra"
  readonly command: string[]
  readonly env: Record<string, string>
  readonly requiredTools: readonly string[]
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface ProxyTrustAttestation extends ProxyCertificateAttestation {
  readonly bundleSha256: string
}

interface PersistedProxyTrustAttestation {
  readonly version: 1
  readonly fingerprint256: string
  readonly spki: string
  readonly bundleSha256: string
}

function secret() {
  return randomBytes(32).toString("base64url")
}

function dockerEnv(env: Record<string, string>) {
  return Object.fromEntries(
    [...Object.entries(process.env), ...Object.entries(env)].filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

async function docker(command: string[], options: DockerOptions = {}) {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? DOCKER_COMMAND_TIMEOUT_MS)
  const abort = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  const result = await Process.run(command, {
    env: dockerEnv(options.env ?? {}),
    abort,
    timeout: DOCKER_KILL_GRACE_MS,
    nothrow: true,
    maxOutputBytes: DOCKER_OUTPUT_LIMIT_BYTES,
  })
  const stderr = result.stderr.toString("utf8").trim()
  if (result.code !== 0) throw new Error(`${command.slice(0, 3).join(" ")} exited ${result.code}: ${stderr}`)
  return result.stdout.toString("utf8").trim()
}

async function dockerResult(command: string[], options: DockerOptions = {}) {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? DOCKER_COMMAND_TIMEOUT_MS)
  const abort = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  return Process.run(command, {
    env: dockerEnv(options.env ?? {}),
    abort,
    timeout: DOCKER_KILL_GRACE_MS,
    nothrow: true,
    maxOutputBytes: DOCKER_OUTPUT_LIMIT_BYTES,
  })
}

async function removeDockerNetwork(name: string, signal?: AbortSignal) {
  const result = await dockerResult(["docker", "network", "rm", name], { signal })
  if (result.code !== 0 && !result.stderr.toString("utf8").includes("No such network"))
    throw new Error(`docker network rm exited ${result.code}`)
}

interface TlsClientDiagnostic {
  readonly client: string
  readonly present: boolean
  readonly bundle_sha256: string
  readonly ca_spki_sha256: string
  readonly outcome: "ok" | "failed" | "skipped"
  readonly exit_class: "ok" | "client_absent" | "client_nonzero" | "tls_trust_failure" | "proxy_observation_missing"
  readonly error_code?: string
  readonly cause?: string
}

function tlsFailureClass(stderr: string): Pick<TlsClientDiagnostic, "exit_class" | "cause"> {
  if (/certificate|self[- ]signed|issuer|verify failed|unable to get local/i.test(stderr))
    return { exit_class: "tls_trust_failure", cause: "the client rejected the attested proxy certificate chain" }
  return { exit_class: "client_nonzero", cause: "the client exited nonzero during the private HTTPS canary" }
}

async function zapCanaryMessageCount(input: {
  readonly apiKey: string
  readonly canaryOrigin: string
  readonly proxyUrl: string
  readonly signal?: AbortSignal
}) {
  const endpoint = new URL("/JSON/core/view/messages/", input.proxyUrl)
  endpoint.searchParams.set("apikey", input.apiKey)
  endpoint.searchParams.set("baseurl", input.canaryOrigin)
  endpoint.searchParams.set("start", "0")
  endpoint.searchParams.set("count", "9999")
  const response = await fetch(endpoint, {
    headers: { Host: "zap" },
    signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`ZAP canary history returned HTTP ${response.status}`)
  const body: unknown = await response.json()
  return isRecord(body) && Array.isArray(body.messages) ? body.messages.length : 0
}

async function deleteZapCanaryHistory(input: {
  readonly apiKey: string
  readonly canaryOrigin: string
  readonly proxyUrl: string
  readonly signal?: AbortSignal
}) {
  const endpoint = new URL("/JSON/core/action/deleteSiteNode/", input.proxyUrl)
  endpoint.searchParams.set("apikey", input.apiKey)
  endpoint.searchParams.set("url", input.canaryOrigin)
  const response = await fetch(endpoint, {
    headers: { Host: "zap" },
    signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`ZAP canary cleanup returned HTTP ${response.status}`)
}

async function waitForTlsCanary(container: string, signal?: AbortSignal) {
  const deadline = Date.now() + TLS_CANARY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await dockerResult(["docker", "exec", container, "test", "-f", "/tmp/cyberful-tls-canary.ready"], {
      signal,
      timeoutMs: 3_000,
    })
    if (result.code === 0) return
    await sleep(100, signal)
  }
  throw new Error("private TLS canary did not become ready")
}

async function verifyTlsClientCanary(input: {
  readonly apiKey: string
  readonly bundleSha256: string
  readonly canaryContainer: string
  readonly caSpki: string
  readonly container: string
  readonly network: string
  readonly ownershipLabels: readonly string[]
  readonly proxyContainer: string
  readonly proxyUrl: string
  readonly signal?: AbortSignal
  readonly workarea: string
  readonly phase?: string
  readonly attempt?: number
}) {
  const canaryOrigin = `https://${input.canaryContainer}:${TLS_CANARY_PORT}`
  const canaryScratch = `/tmp/cyberful-tls-canary-${randomBytes(8).toString("hex")}`
  const proxy = new URL(`http://${input.proxyContainer}:8080`)
  const environment = {
    HTTP_PROXY: proxy.toString(),
    HTTPS_PROXY: proxy.toString(),
    http_proxy: proxy.toString(),
    https_proxy: proxy.toString(),
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    SSL_CERT_FILE: CORE_PROXY_CA_BUNDLE,
    CURL_CA_BUNDLE: CORE_PROXY_CA_BUNDLE,
    REQUESTS_CA_BUNDLE: CORE_PROXY_CA_BUNDLE,
    GIT_SSL_CAINFO: CORE_PROXY_CA_BUNDLE,
    GIT_SSL_NO_VERIFY: "false",
    PIP_CERT: CORE_PROXY_CA_BUNDLE,
    NODE_EXTRA_CA_CERTS: CORE_PROXY_CA_BUNDLE,
    NODE_USE_ENV_PROXY: "1",
    BUNDLE_SSL_CA_CERT: CORE_PROXY_CA_BUNDLE,
    BUNDLE_SSL_VERIFY_MODE: "1",
    BUNDLE_GEMFILE: `${canaryScratch}/Gemfile`,
    BUNDLE_USER_CACHE: `${canaryScratch}/bundler-cache`,
    BUNDLE_USER_CONFIG: `${canaryScratch}/bundler-config`,
    BUNDLE_USER_PLUGIN: `${canaryScratch}/bundler-plugin`,
  }
  const nodeScript = [
    'const http=require("http"),tls=require("tls"),fs=require("fs"),u=new URL(process.argv[1]),p=new URL(process.env.HTTPS_PROXY);',
    'const req=http.request({host:p.hostname,port:p.port,method:"CONNECT",path:u.host});',
    'req.on("connect",(_r,s)=>{const t=tls.connect({socket:s,servername:u.hostname,ca:fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS)},()=>{t.write(`GET ${u.pathname} HTTP/1.1\\r\\nHost: ${u.host}\\r\\nConnection: close\\r\\n\\r\\n`)});t.on("data",()=>{});t.on("end",()=>process.exit(0));t.on("error",e=>{console.error(e.code||e.message);process.exit(1)})});',
    'req.on("error",e=>{console.error(e.code||e.message);process.exit(1)});req.end();',
  ].join("")
  const gemfileScript =
    'File.write(ARGV.fetch(0), "source " + ARGV.fetch(1).inspect + "\\ngem \\\"cyberful-canary\\\", \\\"= 0.0.0\\\"\\n")'
  const clients: ReadonlyArray<{
    readonly name: string
    readonly executable: string
    readonly observeProxy?: boolean
    readonly commands: readonly (readonly string[])[]
  }> = [
    {
      name: "curl",
      executable: "/usr/bin/curl",
      observeProxy: true,
      commands: [
        ["curl", "--fail", "--silent", "--show-error", "--max-time", "10", `${canaryOrigin}/health?client=curl`],
      ],
    },
    {
      name: "openssl",
      executable: "/usr/bin/openssl",
      commands: [
        [
          "openssl",
          "s_client",
          "-brief",
          "-verify_return_error",
          "-CAfile",
          CORE_PROXY_CA_BUNDLE,
          "-proxy",
          `${proxy.hostname}:${proxy.port}`,
          "-connect",
          `${input.canaryContainer}:${TLS_CANARY_PORT}`,
          "-servername",
          input.canaryContainer,
        ],
      ],
    },
    {
      name: "git",
      executable: "/usr/bin/git",
      observeProxy: true,
      commands: [["git", "-c", "http.sslVerify=true", "ls-remote", `${canaryOrigin}/git/canary.git`]],
    },
    {
      name: "python-requests",
      executable: "/opt/cyberful-os-venv/bin/python",
      observeProxy: true,
      commands: [
        [
          "/opt/cyberful-os-venv/bin/python",
          "-c",
          "import requests,sys; response=requests.get(sys.argv[1], timeout=10); response.raise_for_status()",
          `${canaryOrigin}/health?client=requests`,
        ],
      ],
    },
    {
      name: "pip",
      executable: "/opt/cyberful-os-venv/bin/pip",
      observeProxy: true,
      commands: [
        [
          "/opt/cyberful-os-venv/bin/pip",
          "download",
          "--no-deps",
          "--disable-pip-version-check",
          "--dest",
          `${canaryScratch}/pip`,
          "--index-url",
          `${canaryOrigin}/simple`,
          "cyberful-canary==0.0.0",
        ],
      ],
    },
    {
      name: "node",
      executable: "/usr/bin/node",
      observeProxy: true,
      commands: [["node", "-e", nodeScript, `${canaryOrigin}/health?client=node`]],
    },
    {
      name: "ruby",
      executable: "/usr/bin/ruby",
      observeProxy: true,
      commands: [["ruby", "-ropen-uri", "-e", "URI.open(ARGV.fetch(0)).read", `${canaryOrigin}/health?client=ruby`]],
    },
    {
      name: "bundler",
      executable: "/usr/bin/bundle",
      observeProxy: true,
      commands: [
        ["ruby", "-e", gemfileScript, environment.BUNDLE_GEMFILE, `${canaryOrigin}/gems`],
        ["bundle", "lock", "--update"],
      ],
    },
  ]
  const diagnostics: TlsClientDiagnostic[] = []
  let operationFailure: unknown
  const cleanupFailures: unknown[] = []
  SubsystemContainer.remember(input.canaryContainer)
  await SubsystemContainer.reap(input.canaryContainer)
  try {
    await docker(
      [
        "docker",
        "run",
        "--detach",
        "--rm",
        "--pull=never",
        "--name",
        input.canaryContainer,
        "--hostname",
        dockerHostname(input.canaryContainer),
        "--network",
        input.network,
        ...input.ownershipLabels.flatMap((label) => ["--label", label]),
        "--entrypoint",
        "/usr/bin/tini",
        cyberfulOsImage(),
        "--",
        "/opt/cyberful-os-venv/bin/python",
        "/opt/cyberful/tls-canary",
        "--hostname",
        input.canaryContainer,
        "--port",
        String(TLS_CANARY_PORT),
      ],
      { signal: input.signal },
    )
    await waitForTlsCanary(input.canaryContainer, input.signal)
    await docker(["docker", "exec", input.container, "mkdir", "-p", canaryScratch], { signal: input.signal })
    for (const client of clients) {
      const present = await dockerResult(["docker", "exec", input.container, "test", "-x", client.executable], {
        signal: input.signal,
        timeoutMs: 3_000,
      }).then((result) => result.code === 0)
      if (!present) {
        diagnostics.push({
          client: client.name,
          present: false,
          bundle_sha256: input.bundleSha256,
          ca_spki_sha256: input.caSpki,
          outcome: "skipped",
          exit_class: "client_absent",
        })
        continue
      }
      const before = client.observeProxy
        ? await zapCanaryMessageCount({
            apiKey: input.apiKey,
            canaryOrigin,
            proxyUrl: input.proxyUrl,
            ...(input.signal ? { signal: input.signal } : {}),
          })
        : 0
      let failed: { readonly code: number; readonly stderr: string } | undefined
      for (const command of client.commands) {
        const result = await dockerResult(
          [
            "docker",
            "exec",
            ...Object.entries(environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
            input.container,
            ...command,
          ],
          { signal: input.signal, timeoutMs: TLS_CANARY_TIMEOUT_MS },
        )
        if (result.code !== 0) {
          failed = { code: result.code, stderr: result.stderr.toString("utf8") }
          break
        }
      }
      if (failed) {
        diagnostics.push({
          client: client.name,
          present: true,
          bundle_sha256: input.bundleSha256,
          ca_spki_sha256: input.caSpki,
          outcome: "failed",
          ...tlsFailureClass(failed.stderr),
          error_code: `exit_${failed.code}`,
        })
        continue
      }
      const observed =
        !client.observeProxy ||
        (await zapCanaryMessageCount({
          apiKey: input.apiKey,
          canaryOrigin,
          proxyUrl: input.proxyUrl,
          ...(input.signal ? { signal: input.signal } : {}),
        })) > before
      diagnostics.push({
        client: client.name,
        present: true,
        bundle_sha256: input.bundleSha256,
        ca_spki_sha256: input.caSpki,
        outcome: observed ? "ok" : "failed",
        exit_class: observed ? "ok" : "proxy_observation_missing",
        ...(!observed
          ? { error_code: "ZAP_HISTORY_MISS", cause: "the client succeeded without a new ZAP canary observation" }
          : {}),
      })
    }
  } catch (error) {
    operationFailure = error
  } finally {
    await deleteZapCanaryHistory({
      apiKey: input.apiKey,
      canaryOrigin,
      proxyUrl: input.proxyUrl,
      ...(input.signal ? { signal: input.signal } : {}),
    }).catch((error) => {
      cleanupFailures.push(error)
    })
    const scratchCleanup = await dockerResult(["docker", "exec", input.container, "rm", "-rf", canaryScratch], {
      signal: input.signal,
      timeoutMs: 5_000,
    })
    if (scratchCleanup.code !== 0) cleanupFailures.push(new Error("private TLS canary scratch cleanup failed"))
    await SubsystemContainer.remove(input.canaryContainer).catch((error) => cleanupFailures.push(error))
  }
  await appendZapLifecycle(input.workarea, {
    event: "tls_client_canary",
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    network: "private_engagement_network",
    external_target_traffic: false,
    outcome: operationFailure ? "failed" : "completed",
    ...(operationFailure
      ? {
          exit_class: "canary_unavailable",
          cause: "the private TLS canary infrastructure did not complete",
        }
      : {}),
    clients: diagnostics,
  })
  const failed = diagnostics.filter((diagnostic) => diagnostic.outcome === "failed")
  if (operationFailure && cleanupFailures.length > 0)
    throw new AggregateError([operationFailure, ...cleanupFailures], "TLS client canary and cleanup failed")
  if (operationFailure) throw new Error("TLS client canary infrastructure failed", { cause: operationFailure })
  if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, "TLS client canary cleanup failed")
  if (failed.length > 0)
    throw new Error(`TLS client canary failed for ${failed.map((diagnostic) => diagnostic.client).join(", ")}`)
  return diagnostics
}

export function zapCoreIsolationMounts(trustPath: string) {
  return [
    "--mount",
    `type=tmpfs,destination=/workspace/${ZAP_RUNTIME_RELATIVE_PATH},tmpfs-size=1048576,tmpfs-mode=0700`,
    "--mount",
    `type=bind,source=${trustPath},target=/workspace/${ZAP_TRUST_RELATIVE_PATH},readonly`,
    "--mount",
    `type=bind,source=${trustPath},target=${CORE_PROXY_TRUST_DIRECTORY},readonly`,
  ]
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex")
}

function zapStateScope(sessionID: string) {
  return sha256(sessionID).slice(0, 32)
}

async function regularTrustFile(filePath: string) {
  const info = await lstat(filePath)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("proxy trust material must be a regular file")
  const value = await readFile(filePath)
  if (value.byteLength === 0 || value.byteLength > MAX_SYSTEM_CA_BUNDLE_BYTES)
    throw new Error("proxy trust material has an invalid size")
  if (value.includes(Buffer.from("PRIVATE KEY")))
    throw new Error("proxy trust material unexpectedly contains private key material")
  return value
}

function parsePersistedProxyTrustAttestation(value: Buffer): PersistedProxyTrustAttestation {
  let parsed: unknown
  try {
    parsed = JSON.parse(value.toString("utf8"))
  } catch (error) {
    throw new Error("persisted proxy trust attestation is not valid JSON", { cause: error })
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.fingerprint256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.fingerprint256) ||
    typeof parsed.spki !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(parsed.spki) ||
    typeof parsed.bundleSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.bundleSha256)
  )
    throw new Error("persisted proxy trust attestation has an invalid schema")
  return {
    version: 1,
    fingerprint256: parsed.fingerprint256,
    spki: parsed.spki,
    bundleSha256: parsed.bundleSha256,
  }
}

export async function readPersistedProxyTrust(trustPath: string): Promise<ProxyTrustAttestation | undefined> {
  let persisted: PersistedProxyTrustAttestation
  try {
    persisted = parsePersistedProxyTrustAttestation(
      await regularTrustFile(path.join(trustPath, ZAP_TRUST_ATTESTATION_FILE)),
    )
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined
    throw error
  }
  const certificate = attestProxyCertificate(await regularTrustFile(path.join(trustPath, "root-ca-public.pem")))
  if (certificate.fingerprint256 !== persisted.fingerprint256 || certificate.spki !== persisted.spki)
    throw new Error("persisted proxy trust identity does not match its public certificate")
  return { ...certificate, bundleSha256: persisted.bundleSha256 }
}

async function persistProxyTrustAttestation(input: {
  readonly attestation: ProxyTrustAttestation
  readonly trustRelativePath: string
  readonly workarea: string
}) {
  const persisted: PersistedProxyTrustAttestation = {
    version: 1,
    fingerprint256: input.attestation.fingerprint256,
    spki: input.attestation.spki,
    bundleSha256: input.attestation.bundleSha256,
  }
  await replaceWorkareaFile(
    input.workarea,
    `${input.trustRelativePath}/${ZAP_TRUST_ATTESTATION_FILE}`,
    `${JSON.stringify(persisted)}\n`,
    { mode: 0o600 },
  )
}

async function copyCoreSystemCaBundle(container: string, signal?: AbortSignal) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "cyberful-proxy-trust-"))
  const temporaryBundle = path.join(temporaryDirectory, "ca-certificates.crt")
  try {
    await docker(["docker", "cp", `${container}:${CORE_SYSTEM_CA_BUNDLE}`, temporaryBundle], { signal })
    const value = await regularTrustFile(temporaryBundle)
    if (!value.includes(Buffer.from("-----BEGIN CERTIFICATE-----")))
      throw new Error("core system CA bundle contains no certificates")
    return value
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function verifyCoreProxyTrust(input: {
  readonly bundleSha256: string
  readonly container: string
  readonly publicCertificatePem: string
  readonly trustPath: string
  readonly signal?: AbortSignal
}) {
  const publicCertificatePath = path.join(input.trustPath, "root-ca-public.pem")
  const bundlePath = path.join(input.trustPath, "ca-bundle.pem")
  const [publicCertificate, bundle] = await Promise.all([
    regularTrustFile(publicCertificatePath),
    regularTrustFile(bundlePath),
  ])
  if (publicCertificate.toString("utf8") !== input.publicCertificatePem)
    throw new Error("public proxy CA file does not match the attested certificate")
  if (sha256(bundle) !== input.bundleSha256) throw new Error("proxy CA bundle digest changed")
  if (!bundle.includes(publicCertificate)) throw new Error("proxy CA bundle does not contain the attested certificate")
  await docker(
    [
      "docker",
      "exec",
      input.container,
      "openssl",
      "verify",
      "-CAfile",
      CORE_PROXY_CA_BUNDLE,
      CORE_PROXY_CA_CERTIFICATE,
    ],
    { signal: input.signal },
  )
}

async function installCoreProxyTrust(input: {
  readonly certificate: ProxyCertificateAttestation
  readonly container: string
  readonly expected?: ProxyTrustAttestation
  readonly signal?: AbortSignal
  readonly trustRelativePath: string
  readonly trustPath: string
  readonly workarea: string
}): Promise<ProxyTrustAttestation> {
  const canonicalTrustPath = await ensureWorkareaDirectory(input.workarea, input.trustRelativePath)
  if (canonicalTrustPath !== input.trustPath)
    throw new Error("proxy trust directory changed from its engagement-owned canonical path")
  if (
    input.expected?.fingerprint256 === input.certificate.fingerprint256 &&
    input.expected.spki === input.certificate.spki
  ) {
    try {
      await verifyCoreProxyTrust({
        bundleSha256: input.expected.bundleSha256,
        container: input.container,
        publicCertificatePem: input.certificate.certificatePem,
        trustPath: input.trustPath,
        ...(input.signal ? { signal: input.signal } : {}),
      })
      await persistProxyTrustAttestation({
        attestation: input.expected,
        trustRelativePath: input.trustRelativePath,
        workarea: input.workarea,
      })
      return input.expected
    } catch (error) {
      input.signal?.throwIfAborted()
      log.warn("engagement proxy trust material failed verification; regenerating once", {
        error: errorMessage(error),
      })
    }
  }

  const systemBundle = await copyCoreSystemCaBundle(input.container, input.signal)
  const separator = systemBundle.at(-1) === 0x0a ? "" : "\n"
  const combined = Buffer.concat([systemBundle, Buffer.from(separator), Buffer.from(input.certificate.certificatePem)])
  if (combined.includes(Buffer.from("PRIVATE KEY")))
    throw new Error("combined proxy CA bundle unexpectedly contains private key material")
  const bundleSha256 = sha256(combined)
  await replaceWorkareaFile(
    input.workarea,
    `${input.trustRelativePath}/root-ca-public.pem`,
    input.certificate.certificatePem,
    {
      mode: 0o600,
    },
  )
  await replaceWorkareaFile(input.workarea, `${input.trustRelativePath}/ca-bundle.pem`, combined, { mode: 0o600 })
  await verifyCoreProxyTrust({
    bundleSha256,
    container: input.container,
    publicCertificatePem: input.certificate.certificatePem,
    trustPath: input.trustPath,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const attestation = { ...input.certificate, bundleSha256 }
  await persistProxyTrustAttestation({
    attestation,
    trustRelativePath: input.trustRelativePath,
    workarea: input.workarea,
  })
  return attestation
}

function proxyTrustLifecycle(attestation: ProxyTrustAttestation) {
  return {
    ca_bundle_attested: true,
    ca_bundle_sha256: attestation.bundleSha256,
    ca_fingerprint_sha256: attestation.fingerprint256,
    ca_spki_sha256: attestation.spki,
  }
}

export function dockerMemoryAllocationWarning(source: string) {
  if (!/^\d+$/.test(source)) throw new Error("Docker returned a non-decimal memory total")
  const available = Number(source)
  if (!Number.isSafeInteger(available) || available <= 0) throw new Error("Docker returned an invalid memory total")
  if (available >= REQUIRED_DOCKER_MEMORY_BYTES) return
  return `Docker has ${(available / 1024 ** 3).toFixed(1)} GiB available; Cyberful requires at least 10 GB of RAM dedicated to Docker for stable security runtimes.`
}

async function dockerMemoryWarning(signal?: AbortSignal) {
  try {
    const source = await docker(["docker", "info", "--format", "{{.MemTotal}}"], { signal })
    return dockerMemoryAllocationWarning(source)
  } catch (error) {
    signal?.throwIfAborted()
    return `Cyberful could not attest the Docker memory allocation (at least 10 GB dedicated to Docker is required): ${errorMessage(error)}`
  }
}

interface ZapSupervisorState {
  readonly status: string
  readonly exitCode?: number
  readonly signal?: number
  readonly restartCount: number
  readonly sessionGeneration: number
  readonly memoryEvents: Readonly<Record<string, number>>
}

function parseZapSupervisorState(value: unknown): ZapSupervisorState {
  if (!isRecord(value) || typeof value.status !== "string") throw new Error("ZAP supervisor state is malformed")
  const integer = (candidate: unknown, fallback = 0) =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : fallback
  const events: Record<string, number> = {}
  if (isRecord(value.memory_events))
    for (const [name, count] of Object.entries(value.memory_events))
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) events[name] = count
  return {
    status: value.status,
    ...(typeof value.exit_code === "number" ? { exitCode: value.exit_code } : {}),
    ...(typeof value.signal === "number" ? { signal: value.signal } : {}),
    restartCount: integer(value.restart_count),
    sessionGeneration: integer(value.session_generation, 1),
    memoryEvents: events,
  }
}

async function readZapSupervisorState(container: string, signal?: AbortSignal) {
  const source = await docker(["docker", "exec", container, "cat", "/run/cyberful/zap.json"], { signal })
  return parseZapSupervisorState(JSON.parse(source))
}

async function appendZapLifecycle(workarea: string, row: Record<string, unknown>) {
  await appendWorkareaFile(
    workarea,
    ZAP_LIFECYCLE_PATH,
    `${JSON.stringify({ version: 1, timestamp: new Date().toISOString(), ...row })}\n`,
    { mode: 0o600 },
  )
}

function sleep(ms: number, signal?: AbortSignal) {
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, ms))
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener("abort", abort)
      resolve()
    }
    function abort() {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

function runtimeIdentity() {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  const gid = typeof process.getgid === "function" ? process.getgid() : undefined
  return {
    uid: uid !== undefined && uid > 0 ? uid : 1000,
    gid: gid !== undefined && gid > 0 ? gid : 1000,
  }
}

async function waitForContainer(container: string, signal?: AbortSignal) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const state = await docker(["docker", "inspect", "--format", "{{.State.Running}}", container], { signal })
    if (state === "true") return
    await sleep(250, signal)
  }
  throw new Error(`engagement container '${container}' did not become ready`)
}

async function waitForZapApi(input: {
  readonly apiKey: string
  readonly container: string
  readonly deadline: number
  readonly proxyUrl: string
  readonly signal?: AbortSignal
  readonly startupTimeoutSeconds: number
}) {
  let lastError: unknown
  while (Date.now() < input.deadline) {
    try {
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(1_500, input.deadline - Date.now())))
      const response = await fetch(
        `${input.proxyUrl}/JSON/core/view/version/?apikey=${encodeURIComponent(input.apiKey)}`,
        {
          headers: { Host: "zap" },
          signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
        },
      )
      if (response.ok) return
      lastError = new Error(`ZAP readiness returned HTTP ${response.status}`)
    } catch (error) {
      input.signal?.throwIfAborted()
      lastError = error
    }
    const remainingMs = input.deadline - Date.now()
    if (remainingMs <= 0) break
    const running = await docker(["docker", "inspect", "--format", "{{.State.Running}}", input.container], {
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: Math.max(1, Math.min(DOCKER_COMMAND_TIMEOUT_MS, remainingMs)),
    })
    if (running !== "true") throw new Error("the dedicated ZAP container exited during API startup")
    const retryDelayMs = Math.min(500, input.deadline - Date.now())
    if (retryDelayMs > 0) await sleep(retryDelayMs, input.signal)
  }
  throw new Error(`timed out after ${input.startupTimeoutSeconds}s waiting for the ZAP API`, {
    cause: lastError,
  })
}

async function waitForGhidra(container: string, signal?: AbortSignal) {
  const deadline = Date.now() + cyberGhidraStartupTimeoutSeconds() * 1000
  while (Date.now() < deadline) {
    const result = await Process.run(
      ["docker", "exec", container, "/opt/cyberful-os-venv/bin/python", "/opt/cyberful/ghidra/healthcheck.py"],
      {
        env: dockerEnv({}),
        abort: signal ? AbortSignal.any([signal, AbortSignal.timeout(3_000)]) : AbortSignal.timeout(3_000),
        timeout: DOCKER_KILL_GRACE_MS,
        nothrow: true,
        maxOutputBytes: DOCKER_OUTPUT_LIMIT_BYTES,
      },
    )
    if (result.code === 0) return
    const running = await docker(["docker", "inspect", "--format", "{{.State.Running}}", container], { signal })
    if (running !== "true") throw new Error("the core engagement container exited during Ghidra startup")
    await sleep(500, signal)
  }
  throw new Error(`timed out after ${cyberGhidraStartupTimeoutSeconds()}s waiting for the Ghidra JVM`)
}

async function proxyCertificate(proxyUrl: string, apiKey: string, signal?: AbortSignal) {
  const response = await fetch(`${proxyUrl}/OTHER/core/other/rootcert/?apikey=${encodeURIComponent(apiKey)}`, {
    headers: { Host: "zap" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`ZAP root CA export returned HTTP ${response.status}`)
  return attestProxyCertificate(new Uint8Array(await response.arrayBuffer()))
}

async function probeBridge(input: BridgeProbeInput) {
  const [command, ...args] = input.command
  if (!command) throw new Error(`${input.name} bridge command is unavailable`)
  const transport = new StdioClientTransport({
    command,
    args,
    env: dockerEnv(input.env),
    stderr: "pipe",
  })
  const diagnostics = new BoundedByteTail(BRIDGE_DIAGNOSTIC_LIMIT_BYTES)
  const capture = (chunk: Buffer) => diagnostics.append(chunk)
  transport.stderr?.on("data", capture)
  const client = new Client({ name: `cyberful-${input.name}-preflight`, version: "0.1.0" })
  const timeoutMs = input.timeoutMs ?? BRIDGE_PREFLIGHT_TIMEOUT_MS
  const deadline = AbortSignal.timeout(timeoutMs)
  const cancellation = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline
  const abort = () => void client.close().catch(() => undefined)
  cancellation.addEventListener("abort", abort, { once: true })
  try {
    await client.connect(transport)
    cancellation.throwIfAborted()
    const requestTimeoutMs = Math.min(20_000, timeoutMs)
    const tools = await client.listTools(undefined, {
      timeout: requestTimeoutMs,
      maxTotalTimeout: requestTimeoutMs,
    })
    const names = new Set(tools.tools.map((tool) => tool.name))
    for (const required of input.requiredTools)
      if (!names.has(required)) throw new Error(`${input.name} MCP is missing required tool ${required}`)
    if (input.name === "zap") {
      const version = await client.callTool({ name: "zap_version", arguments: {} }, CallToolResultSchema, {
        timeout: requestTimeoutMs,
        maxTotalTimeout: requestTimeoutMs,
      })
      if (version.isError) throw new Error("ZAP MCP zap_version health check failed")
    }
  } catch (error) {
    const detail = diagnostics.text().trim()
    throw new Error(detail ? `${errorMessage(error)}\n${input.name} bridge stderr:\n${detail}` : errorMessage(error), {
      cause: error,
    })
  } finally {
    cancellation.removeEventListener("abort", abort)
    transport.stderr?.off("data", capture)
    await client.close().catch(() => undefined)
  }
}

// ── ZAP Is Ready Only After Its MCP Listener Accepts Requests ───
// ZAP's core API can answer before its MCP add-on begins listening, so an HTTP
// response alone cannot authorize phase gateways or proxy-dependent policy.
// Startup retries the definitive bridge handshake within the same configured
// deadline used by the API probe and confirms the container remains alive.
// Retries end when startup returns; a service that dies later still fails fast
// and remains stopped under the supervisor's no-restart contract.
//
// @docs/runtimes/cyberful-os.md
// ─────────────────────────────────────────────────────────────────
async function waitForZapBridge(input: {
  readonly command: string[]
  readonly container: string
  readonly deadline: number
  readonly env: Record<string, string>
  readonly signal?: AbortSignal
  readonly startupTimeoutSeconds: number
}) {
  let lastError: unknown
  while (Date.now() < input.deadline) {
    try {
      await probeBridge({
        name: "zap",
        command: input.command,
        env: input.env,
        requiredTools: ["zap_version"],
        timeoutMs: Math.max(1, Math.min(BRIDGE_PREFLIGHT_TIMEOUT_MS, input.deadline - Date.now())),
        ...(input.signal ? { signal: input.signal } : {}),
      })
      return
    } catch (error) {
      input.signal?.throwIfAborted()
      lastError = error
    }
    const remainingMs = input.deadline - Date.now()
    if (remainingMs <= 0) break
    const running = await docker(["docker", "inspect", "--format", "{{.State.Running}}", input.container], {
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: Math.max(1, Math.min(DOCKER_COMMAND_TIMEOUT_MS, remainingMs)),
    })
    if (running !== "true") throw new Error("the dedicated ZAP container exited during MCP startup")
    const retryDelayMs = Math.min(500, input.deadline - Date.now())
    if (retryDelayMs > 0) await sleep(retryDelayMs, input.signal)
  }
  throw new Error(`timed out after ${input.startupTimeoutSeconds}s waiting for the ZAP MCP`, {
    cause: lastError,
  })
}

async function verifyCore(container: string, signal?: AbortSignal) {
  await docker(["docker", "exec", container, "/opt/cyberful-os-venv/bin/python", "/opt/cyberful/runtime-attestation"], {
    signal,
    timeoutMs: 120_000,
  })
}

// ── Network And Platform Authority Are Fixed At Startup ─────────
// Code Audit starts this same image with Docker networking disabled and never
// starts ZAP. Live-target workflows publish only ZAP's proxy on host loopback.
// No phase may mutate those choices later, so sequential gateways reconnect to
// stable engagement roles without phase-local privilege escalation. After core
// attestation, kernel and machine identity are normalized into a host-owned
// prompt fact so agents reject incompatible exact-build execution plans early.
// The workarea remains writable by design; Ghidra alone also receives its store.
//
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────
export async function startEngagement(input: {
  readonly sessionID: string
  readonly workflow: string
  readonly container: string
  readonly workarea: string
  readonly ghidraStore?: string
  readonly objective?: string
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: EngagementRuntimeProgress) => void
  readonly onDiagnostic?: (input: {
    readonly component: "zap" | "ghidra"
    readonly severity: "warning" | "error"
    readonly errorClass: string
    readonly message: string
  }) => void
}): Promise<EngagementRuntime> {
  input.signal?.throwIfAborted()
  const codeAudit = input.workflow === "code-audit"
  const zapEnabled = !codeAudit && shouldEnableCyberZap()
  const ghidraEnabled = Boolean(input.ghidraStore) && shouldEnableCyberGhidra()
  const progressServices = [
    { id: "cyber-os", label: "CyberOS" },
    ...(zapEnabled ? [{ id: "zap", label: "OWASP ZAP" } as const] : []),
    ...(ghidraEnabled ? [{ id: "ghidra", label: "Ghidra" } as const] : []),
  ] satisfies readonly { readonly id: EngagementRuntimeServiceID; readonly label: string }[]
  const progressStates = new Map<EngagementRuntimeServiceID, EngagementRuntimeServiceState>(
    progressServices.map((service) => [service.id, "pending"] as const),
  )
  const reportProgress = (
    message: string,
    updates: readonly { readonly id: EngagementRuntimeServiceID; readonly state: EngagementRuntimeServiceState }[],
    state: EngagementRuntimeProgress["state"] = "active",
  ) => {
    for (const update of updates) progressStates.set(update.id, update.state)
    const services = progressServices.map((service) => ({
      ...service,
      state: progressStates.get(service.id) ?? "pending",
    }))
    const completed = services.filter((service) => service.state === "ready" || service.state === "degraded").length
    try {
      input.onProgress?.({ state, message, completed, total: services.length, services })
    } catch (error) {
      log.warn("engagement runtime progress observer failed", { error })
    }
  }
  reportProgress("Starting the isolated CyberOS runtime", [{ id: "cyber-os", state: "active" }])
  let policy = await readEngagementPolicy(input.workarea)
  const zapRequired = requiresZapUpstream(input.workflow, policy)

  const apiKey = zapEnabled ? secret() : undefined
  const zapMcpKey = zapEnabled ? secret() : undefined
  const ghidraMcpKey = ghidraEnabled ? secret() : undefined
  const coreServiceEnv = {
    CYBERFUL_ZAP_ENABLED: "0",
    CYBERFUL_GHIDRA_ENABLED: ghidraEnabled ? "1" : "0",
    ...(ghidraMcpKey ? { CYBER_GHIDRA_MCP_KEY: ghidraMcpKey } : {}),
  }
  const identity = runtimeIdentity()
  const zapContainer = dockerChildContainerName(input.container, "zap")
  const containers = zapEnabled ? [input.container, zapContainer] : [input.container]
  let published = cyberZapProxyPort() ? `127.0.0.1:${cyberZapProxyPort()}:8080` : "127.0.0.1::8080"
  let publishedPort: number | undefined
  let sessionGeneration = 1
  const coreOwnershipLabels = dockerOwnershipLabels({
    managed: "engagement",
    runtime: "cyberful-os",
    session: input.sessionID,
  })
  const zapOwnershipLabels = dockerOwnershipLabels({
    managed: "engagement",
    runtime: "cyberful-zap",
    session: input.sessionID,
  })
  const network = `${input.container.slice(0, 40)}-${zapStateScope(input.sessionID).slice(0, 12)}-net`
  const tlsCanaryContainer = `${input.container.slice(0, 40)}-${zapStateScope(input.sessionID).slice(0, 12)}-tls`
  const zapScope = zapStateScope(input.sessionID)
  const zapRuntimeRelativePath = `${ZAP_RUNTIME_RELATIVE_PATH}/${zapScope}`
  const zapTrustRelativePath = `${ZAP_TRUST_RELATIVE_PATH}/${zapScope}`
  const zapRuntimePath = zapEnabled ? await ensureWorkareaDirectory(input.workarea, zapRuntimeRelativePath) : undefined
  const zapTrustPath = zapEnabled ? await ensureWorkareaDirectory(input.workarea, zapTrustRelativePath) : undefined
  let runtimePlatform: string
  if (zapRuntimePath && zapTrustPath) await Promise.all([chmod(zapRuntimePath, 0o700), chmod(zapTrustPath, 0o700)])
  let persistedProxyTrust: ProxyTrustAttestation | undefined
  if (zapTrustPath)
    try {
      persistedProxyTrust = await readPersistedProxyTrust(zapTrustPath)
    } catch (error) {
      throw new RequiredUpstreamUnavailableError("persisted ZAP proxy trust failed continuity validation", {
        cause: error,
      })
    }

  for (const container of containers) {
    SubsystemContainer.remember(container)
    await SubsystemContainer.reap(container)
  }
  await removeDockerNetwork(network, input.signal).catch(() => undefined)
  await docker(
    [
      "docker",
      "network",
      "create",
      "--driver",
      "bridge",
      ...coreOwnershipLabels.flatMap((label) => ["--label", label]),
      network,
    ],
    { signal: input.signal },
  )
  const warnings: string[] = []
  const memoryWarning = await dockerMemoryWarning(input.signal)
  if (memoryWarning) warnings.push(memoryWarning)
  try {
    await docker(
      [
        "docker",
        "run",
        "--detach",
        "--rm",
        "--pull=never",
        "--name",
        input.container,
        "--hostname",
        dockerHostname(input.container),
        "--network",
        network,
        "--workdir",
        "/workspace",
        ...coreOwnershipLabels.flatMap((label) => ["--label", label]),
        "--cap-add=NET_ADMIN",
        "--cap-add=SYS_PTRACE",
        "--security-opt=no-new-privileges",
        "--security-opt=seccomp=unconfined",
        "--oom-score-adj=250",
        "--pids-limit=2048",
        ...(codeAudit ? ["--network", "none"] : ["--add-host", "host.docker.internal:host-gateway"]),
        "--mount",
        `type=bind,source=${input.workarea},target=/workspace`,
        ...(zapTrustPath ? zapCoreIsolationMounts(zapTrustPath) : []),
        ...(ghidraEnabled && input.ghidraStore
          ? ["--mount", `type=bind,source=${input.ghidraStore},target=/ghidra/store`]
          : []),
        "--env",
        `CYBERFUL_RUNTIME_UID=${identity.uid}`,
        "--env",
        `CYBERFUL_RUNTIME_GID=${identity.gid}`,
        ...Object.keys(coreServiceEnv).flatMap((name) => ["--env", name]),
        cyberfulOsImage(),
      ],
      { env: coreServiceEnv, signal: input.signal },
    )
    await waitForContainer(input.container, input.signal)
    await verifyCore(input.container, input.signal)
    const [kernel, machine] = await Promise.all([
      docker(["docker", "exec", input.container, "uname", "-s"], { signal: input.signal }),
      docker(["docker", "exec", input.container, "uname", "-m"], { signal: input.signal }),
    ])
    runtimePlatform = cyberfulOsRuntimePlatform(kernel, machine)
    reportProgress(
      zapEnabled
        ? "CyberOS is ready; starting OWASP ZAP"
        : ghidraEnabled
          ? "CyberOS is ready; starting headless Ghidra"
          : "CyberOS startup checks passed",
      [
        { id: "cyber-os", state: "ready" },
        ...(zapEnabled
          ? ([{ id: "zap", state: "active" }] as const)
          : ghidraEnabled
            ? ([{ id: "ghidra", state: "active" }] as const)
            : []),
      ],
    )
  } catch (error) {
    await Promise.all(containers.map((container) => SubsystemContainer.remove(container))).catch((cleanupError) => {
      throw new AggregateError([error, cleanupError], "unified engagement runtime startup and cleanup failed")
    })
    await removeDockerNetwork(network, input.signal).catch(() => undefined)
    throw error
  }

  const env: Record<string, string> = {
    CYBERFUL_OS_CONTAINER: input.container,
    CYBERFUL_OS_RUNTIME_PLATFORM: runtimePlatform,
    ...(zapEnabled ? { CYBERFUL_ZAP_RUNTIME_CONTAINER: zapContainer } : {}),
    CYBERFUL_OS_IMAGE: cyberfulOsImage(),
    CYBERFUL_OS_REQUIRE_ENGAGEMENT_CONTAINER: "1",
    ...(engagementPolicyRequiresZap(policy) ? { CYBER_ZAP_REQUIRED_BY_POLICY: "1" } : {}),
  }
  let degraded = Boolean(memoryWarning)
  let proxyUrl: string | undefined
  let expectedTrust = persistedProxyTrust
  let zapOperational = false

  const runZapContainer = async (generation: number, signal?: AbortSignal) => {
    if (!apiKey || !zapMcpKey || !zapRuntimePath) throw new Error("ZAP runtime inputs are unavailable")
    const zapEnv = {
      CYBERFUL_ZAP_ENABLED: "1",
      CYBERFUL_GHIDRA_ENABLED: "0",
      CYBER_ZAP_API_KEY: apiKey,
      CYBER_ZAP_MCP_KEY: zapMcpKey,
      CYBER_ZAP_MAX_HISTORY_RESPONSE_BYTES: String(cyberZapMaxHistoryResponseBytes()),
      CYBER_ZAP_SESSION_GENERATION: String(generation),
    }
    await docker(
      [
        "docker",
        "run",
        "--detach",
        "--rm",
        "--pull=never",
        "--name",
        zapContainer,
        "--hostname",
        dockerHostname(zapContainer),
        "--network",
        network,
        "--workdir",
        "/zap/wrk",
        ...zapOwnershipLabels.flatMap((label) => ["--label", label]),
        "--pids-limit=1024",
        "--add-host",
        "host.docker.internal:host-gateway",
        "--publish",
        publishedPort === undefined ? published : `127.0.0.1:${publishedPort}:8080`,
        "--mount",
        `type=bind,source=${input.workarea},target=/zap/wrk`,
        "--mount",
        `type=bind,source=${zapRuntimePath},target=/var/lib/cyberful/zap`,
        "--env",
        `CYBERFUL_RUNTIME_UID=${identity.uid}`,
        "--env",
        `CYBERFUL_RUNTIME_GID=${identity.gid}`,
        ...Object.keys(zapEnv).flatMap((name) => ["--env", name]),
        cyberfulOsImage(),
      ],
      { env: zapEnv, signal },
    )
    await waitForContainer(zapContainer, signal)
    const nextPort = parsePublishedPort(await docker(["docker", "port", zapContainer, "8080/tcp"], { signal }))
    publishedPort ??= nextPort
    if (nextPort !== publishedPort) throw new Error("ZAP did not retain its host proxy port")
    proxyUrl = `http://127.0.0.1:${publishedPort}`
  }

  const attestZap = async (
    options: {
      readonly allowCaRotation?: boolean
      readonly signal?: AbortSignal
      readonly phase?: string
      readonly attempt?: number
    } = {},
  ) => {
    const signal = options.signal
    if (!apiKey || !zapMcpKey || !proxyUrl || !zapTrustPath) throw new Error("ZAP runtime has no active trust endpoint")
    const activeProxyUrl = proxyUrl
    const startupTimeoutSeconds = cyberZapStartupTimeoutSeconds()
    const deadline = Date.now() + startupTimeoutSeconds * 1000
    const attest = async <T>(stage: ZapAttestationStage, operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation()
      } catch (error) {
        signal?.throwIfAborted()
        throw new ZapAttestationStageError(stage, error)
      }
    }
    await attest("api", () =>
      waitForZapApi({
        apiKey,
        container: zapContainer,
        deadline,
        proxyUrl: activeProxyUrl,
        startupTimeoutSeconds,
        ...(signal ? { signal } : {}),
      }),
    )
    const zapReadyEnv = {
      ...env,
      CYBER_ZAP_READY: "1",
      CYBER_ZAP_API_KEY: apiKey,
      CYBER_ZAP_MCP_KEY: zapMcpKey,
      CYBER_ZAP_PROXY_URL: activeProxyUrl,
      CYBER_ZAP_WORKAREA: input.workarea,
      CYBER_ZAP_REQUIRED_UPSTREAM: "1",
    }
    await attest("mcp", () =>
      waitForZapBridge({
        command: cyberZapBridgeCommand(zapContainer),
        container: zapContainer,
        deadline,
        env: zapReadyEnv,
        startupTimeoutSeconds,
        ...(signal ? { signal } : {}),
      }),
    )
    let state = await attest("supervisor", () => readZapSupervisorState(zapContainer, signal))
    while (state.status === "starting" && Date.now() < deadline) {
      await sleep(250, signal)
      state = await attest("supervisor", () => readZapSupervisorState(zapContainer, signal))
    }
    if (state.status !== "ready")
      throw new ZapAttestationStageError("supervisor", new Error(`ZAP supervisor state is ${state.status}`))
    policy = await readEngagementPolicy(input.workarea)
    const trafficPolicy = await attest("traffic_policy", () =>
      applyEngagementTrafficPolicy(policy, { proxyUrl: activeProxyUrl, apiKey, ...(signal ? { signal } : {}) }),
    )
    if (engagementPolicyRequiresZap(policy)) env.CYBER_ZAP_REQUIRED_BY_POLICY = "1"
    else delete env.CYBER_ZAP_REQUIRED_BY_POLICY
    const trust = await attest("ca", async () => {
      const certificate = await proxyCertificate(activeProxyUrl, apiKey, signal)
      const changed =
        expectedTrust !== undefined &&
        (expectedTrust.spki !== certificate.spki || expectedTrust.fingerprint256 !== certificate.fingerprint256)
      if (changed && !options.allowCaRotation)
        throw new Error("ZAP CA certificate changed without an authorized session reset")
      return installCoreProxyTrust({
        certificate,
        container: input.container,
        expected: expectedTrust,
        trustRelativePath: zapTrustRelativePath,
        trustPath: zapTrustPath,
        workarea: input.workarea,
        ...(signal ? { signal } : {}),
      })
    })
    await attest("tls_canary", () =>
      verifyTlsClientCanary({
        apiKey,
        bundleSha256: trust.bundleSha256,
        canaryContainer: tlsCanaryContainer,
        caSpki: trust.spki,
        container: input.container,
        network,
        ownershipLabels: coreOwnershipLabels,
        proxyContainer: zapContainer,
        proxyUrl: activeProxyUrl,
        workarea: input.workarea,
        ...(options.phase ? { phase: options.phase } : {}),
        ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
        ...(signal ? { signal } : {}),
      }),
    )
    const readyEnv = { ...zapReadyEnv, CYBERFUL_OS_CA_BUNDLE: CORE_PROXY_CA_BUNDLE }
    sessionGeneration = state.sessionGeneration
    Object.assign(env, readyEnv, {
      ...(shouldChainBrowserThroughZap()
        ? { CYBER_BROWSER_PROXY: activeProxyUrl, CYBER_BROWSER_PROXY_CA_SPKI: trust.spki }
        : {}),
    })
    return { state, trust, trafficPolicy }
  }

  if (zapEnabled && apiKey && zapMcpKey) {
    try {
      await runZapContainer(sessionGeneration, input.signal)
      reportProgress("Attesting ZAP, proxy trust, and TLS clients", [{ id: "zap", state: "active" }])
      const attestation = await attestZap({ allowCaRotation: expectedTrust === undefined, signal: input.signal })
      expectedTrust = attestation.trust
      zapOperational = true
      await appendZapLifecycle(input.workarea, {
        event: "startup_ready",
        container: zapContainer,
        status: attestation.state.status,
        restart_count: attestation.state.restartCount,
        session_generation: attestation.state.sessionGeneration,
        memory_events: attestation.state.memoryEvents,
        ...proxyTrustLifecycle(attestation.trust),
        traffic_policy_attested: attestation.trafficPolicy.state === "enforced",
        rate_limit_attested: attestation.trafficPolicy.rate_limit.state === "configured",
        required_headers_attested:
          attestation.trafficPolicy.required_headers.state === "configured"
            ? attestation.trafficPolicy.required_headers.count
            : 0,
      })
      const targetWarning = localTargetWarning(input.objective ?? "")
      if (targetWarning) warnings.push(targetWarning)
      reportProgress(
        ghidraEnabled ? "OWASP ZAP is ready; starting headless Ghidra" : "OWASP ZAP startup checks passed",
        [
          { id: "zap", state: "ready" },
          ...(ghidraEnabled ? ([{ id: "ghidra", state: "active" }] as const) : []),
        ],
      )
    } catch (error) {
      input.signal?.throwIfAborted()
      const state = await readZapSupervisorState(zapContainer, input.signal).catch(() => undefined)
      input.onDiagnostic?.({
        component: "zap",
        severity: "error",
        errorClass: error instanceof Error ? error.name || "ZapStartupError" : "ZapStartupError",
        message: errorMessage(error),
      })
      await appendZapLifecycle(input.workarea, {
        event: "startup_failed",
        container: zapContainer,
        ...(state
          ? {
              status: state.status,
              exit_code: state.exitCode,
              signal: state.signal,
              restart_count: state.restartCount,
              session_generation: state.sessionGeneration,
              memory_events: state.memoryEvents,
            }
          : { status: "unreachable" }),
        error_class: error instanceof Error ? error.name : "ZapStartupError",
        ...(error instanceof ZapAttestationStageError ? { failure_stage: error.stage } : {}),
      })
      degraded = true
      const warning = zapRequired
        ? `OWASP ZAP failed startup attestation; target phases remain blocked until bounded preflight recovery succeeds: ${errorMessage(error)}`
        : `OWASP ZAP unavailable; browser traffic will use the direct fallback: ${errorMessage(error)}`
      warnings.push(warning)
      reportProgress(
        ghidraEnabled
          ? "OWASP ZAP needs bounded recovery; starting headless Ghidra"
          : "OWASP ZAP needs bounded recovery before target traffic",
        [
          { id: "zap", state: "degraded" },
          ...(ghidraEnabled ? ([{ id: "ghidra", state: "active" }] as const) : []),
        ],
      )
      if (!zapRequired) {
        await SubsystemContainer.remove(zapContainer).catch(() => undefined)
        env.CYBER_BROWSER_PROXY_WARNING = warning
      }
    }
  }

  const preparePhase: EngagementRuntime["preparePhase"] = async ({ phase, attempt, signal }) => {
    if (!zapEnabled) {
      if (zapRequired)
        throw new RequiredUpstreamUnavailableError("required OWASP ZAP upstream is disabled for a live-target workflow")
      return { warnings: [], env: {} }
    }
    const phaseWarnings: string[] = []
    try {
      const attestation = await attestZap({ phase, attempt, signal })
      expectedTrust = attestation.trust
      await appendZapLifecycle(input.workarea, {
        event: "phase_preflight_ready",
        phase,
        attempt,
        container: zapContainer,
        status: attestation.state.status,
        restart_count: attestation.state.restartCount,
        session_generation: attestation.state.sessionGeneration,
        memory_events: attestation.state.memoryEvents,
        ...proxyTrustLifecycle(attestation.trust),
        ca_spki_changed: false,
        ca_certificate_changed: false,
        traffic_policy_attested: attestation.trafficPolicy.state === "enforced",
        rate_limit_attested: attestation.trafficPolicy.rate_limit.state === "configured",
        required_headers_attested:
          attestation.trafficPolicy.required_headers.state === "configured"
            ? attestation.trafficPolicy.required_headers.count
            : 0,
      })
      zapOperational = true
      return { warnings: phaseWarnings, env: { ...env } }
    } catch (initialError) {
      signal?.throwIfAborted()
      const state = await readZapSupervisorState(zapContainer, signal).catch(() => undefined)
      await appendZapLifecycle(input.workarea, {
        event: "phase_preflight_failed",
        phase,
        attempt,
        container: zapContainer,
        ...(state
          ? {
              status: state.status,
              exit_code: state.exitCode,
              signal: state.signal,
              restart_count: state.restartCount,
              session_generation: state.sessionGeneration,
              memory_events: state.memoryEvents,
            }
          : { status: "unreachable" }),
        error_class: initialError instanceof Error ? initialError.name : "ZapPreflightError",
        ...(initialError instanceof ZapAttestationStageError ? { failure_stage: initialError.stage } : {}),
      })
    }

    const recover = async (mode: "preserve" | "reset") => {
      const running = await docker(["docker", "inspect", "--format", "{{.State.Running}}", zapContainer], {
        signal,
      }).catch(() => "false")
      if (running === "true") {
        const previous = await readZapSupervisorState(zapContainer, signal)
        await docker(["docker", "kill", "--signal", mode === "preserve" ? "USR1" : "USR2", zapContainer], {
          signal,
        })
        const recoveryDeadline = Date.now() + 15_000
        let restarted = await readZapSupervisorState(zapContainer, signal)
        while (
          Date.now() < recoveryDeadline &&
          (restarted.restartCount <= previous.restartCount ||
            (mode === "reset" && restarted.sessionGeneration <= previous.sessionGeneration))
        ) {
          await sleep(100, signal)
          restarted = await readZapSupervisorState(zapContainer, signal)
        }
        if (
          restarted.restartCount <= previous.restartCount ||
          (mode === "reset" && restarted.sessionGeneration <= previous.sessionGeneration)
        )
          throw new Error(`ZAP supervisor did not acknowledge the explicit ${mode} recovery`)
      } else {
        await SubsystemContainer.remove(zapContainer).catch(() => undefined)
        if (mode === "reset") sessionGeneration += 1
        await runZapContainer(sessionGeneration, signal)
      }
      const previousTrust = expectedTrust
      const attestation = await attestZap({ allowCaRotation: mode === "reset", phase, attempt, signal })
      const spkiChanged = previousTrust !== undefined && previousTrust.spki !== attestation.trust.spki
      const certificateChanged =
        previousTrust !== undefined && previousTrust.fingerprint256 !== attestation.trust.fingerprint256
      expectedTrust = attestation.trust
      if (mode === "reset" && (spkiChanged || certificateChanged))
        await appendZapLifecycle(input.workarea, {
          event: "ca_rotation_authorized",
          phase,
          attempt,
          ...proxyTrustLifecycle(attestation.trust),
          ca_spki_changed: spkiChanged,
          ca_certificate_changed: certificateChanged,
        })
      await appendZapLifecycle(input.workarea, {
        event: "phase_recovery_ready",
        phase,
        attempt,
        container: zapContainer,
        recovery_mode: mode,
        status: attestation.state.status,
        restart_count: attestation.state.restartCount,
        session_generation: attestation.state.sessionGeneration,
        memory_events: attestation.state.memoryEvents,
        ...proxyTrustLifecycle(attestation.trust),
        ca_spki_changed: spkiChanged,
        ca_certificate_changed: certificateChanged,
        continuity_reset: mode === "reset",
        traffic_policy_attested: attestation.trafficPolicy.state === "enforced",
        rate_limit_attested: attestation.trafficPolicy.rate_limit.state === "configured",
        required_headers_attested:
          attestation.trafficPolicy.required_headers.state === "configured"
            ? attestation.trafficPolicy.required_headers.count
            : 0,
      })
      return attestation
    }

    try {
      await recover("preserve")
      zapOperational = true
      phaseWarnings.push("OWASP ZAP was recovered before this phase with its persistent session preserved.")
    } catch (preserveError) {
      signal?.throwIfAborted()
      await appendZapLifecycle(input.workarea, {
        event: "phase_recovery_failed",
        phase,
        attempt,
        container: zapContainer,
        recovery_mode: "preserve",
        error_class: preserveError instanceof Error ? preserveError.name : "ZapRecoveryError",
        ...(preserveError instanceof ZapAttestationStageError ? { failure_stage: preserveError.stage } : {}),
      })
      try {
        await recover("reset")
        zapOperational = true
        const warning =
          "OWASP ZAP recovery required a new visible session generation; prior proxy history may be incomplete."
        phaseWarnings.push(warning)
        warnings.push(warning)
      } catch (resetError) {
        await appendZapLifecycle(input.workarea, {
          event: "phase_recovery_failed",
          phase,
          attempt,
          container: zapContainer,
          recovery_mode: "reset",
          error_class: resetError instanceof Error ? resetError.name : "ZapRecoveryError",
          ...(resetError instanceof ZapAttestationStageError ? { failure_stage: resetError.stage } : {}),
        })
        throw new RequiredUpstreamUnavailableError(
          `required OWASP ZAP upstream is unavailable after bounded recovery: ${errorMessage(resetError)}`,
          { cause: new AggregateError([preserveError, resetError], "ZAP recovery attempts failed") },
        )
      }
    }
    return { warnings: phaseWarnings, env: { ...env } }
  }

  if (ghidraEnabled && ghidraMcpKey) {
    reportProgress("Starting headless Ghidra and its MCP bridge", [{ id: "ghidra", state: "active" }])
    try {
      await waitForGhidra(input.container, input.signal)
      Object.assign(env, { CYBER_GHIDRA_READY: "1", CYBER_GHIDRA_MCP_KEY: ghidraMcpKey })
      await probeBridge({
        name: "ghidra",
        command: cyberGhidraBridgeCommand(input.container),
        env,
        requiredTools: ["ghidra_project", "ghidra_import", "ghidra_decompile", "ghidra_call_graph"],
        ...(input.signal ? { signal: input.signal } : {}),
      })
      reportProgress("Headless Ghidra startup checks passed", [{ id: "ghidra", state: "ready" }])
    } catch (error) {
      input.signal?.throwIfAborted()
      input.onDiagnostic?.({
        component: "ghidra",
        severity: "error",
        errorClass: error instanceof Error ? error.name || "GhidraStartupError" : "GhidraStartupError",
        message: errorMessage(error),
      })
      degraded = true
      warnings.push(`Headless Ghidra unavailable; binary analysis tools are disabled: ${errorMessage(error)}`)
      reportProgress("Headless Ghidra is unavailable", [{ id: "ghidra", state: "degraded" }])
    }
  }

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    if (proxyUrl && apiKey)
      await fetch(`${proxyUrl}/JSON/core/action/shutdown/?apikey=${encodeURIComponent(apiKey)}`, {
        headers: { Host: "zap" },
        signal: AbortSignal.timeout(2_000),
      }).catch((error) => log.warn("ZAP graceful shutdown failed; removing engagement runtimes", { error }))
    const removals = await Promise.allSettled(containers.map((container) => SubsystemContainer.remove(container)))
    const networkRemoval = await Promise.allSettled([removeDockerNetwork(network)])
    const failures = [...removals, ...networkRemoval].flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    )
    if (failures.length > 0) throw new AggregateError(failures, "one or more engagement runtimes failed to stop")
  }
  log.info("engagement runtimes ready", {
    container: input.container,
    zapContainer: zapOperational ? zapContainer : undefined,
    codeAudit,
    zap: env.CYBER_ZAP_READY === "1",
    ghidra: env.CYBER_GHIDRA_READY === "1",
  })
  reportProgress(
    degraded ? "Engagement runtime ready with limited capabilities" : "Engagement runtime ready",
    [],
    degraded ? "degraded" : "ready",
  )
  return {
    container: input.container,
    containers,
    ...(zapOperational ? { zapContainer } : {}),
    env,
    degraded,
    warnings,
    preparePhase,
    stop,
  }
}

export * as SubsystemEngagementRuntime from "./engagement-runtime"
