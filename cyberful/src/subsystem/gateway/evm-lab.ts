// ── Managed Local EVM Lab ───────────────────────────────────────────────────
// Materializes authenticated sources and operates one engagement-owned Anvil
// node. The convenience boundary is lifecycle-only: Forge, Cast, shell access,
// direct public RPC access, and additional model-started nodes remain untouched.
// → cyberful/src/subsystem/evm/runtime.ts — guarantees terminal cleanup.
// @docs/runtimes/evm.md
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import { lstat, readFile, realpath, rm } from "node:fs/promises"
import { replaceWorkareaFile } from "@/workarea"
import { dockerOwnershipLabels } from "@/util/container-ownership"
import {
  dockerCommand,
  EVM_RUNTIME_LABEL,
  EVM_VARIABLE_DESCRIPTION_PREFIX,
} from "../evm/runtime"
import { materializeSourcesForEvmLab } from "./source-tools"

const STATE_PATH = "raw/evm/lab.json"
const READY_TIMEOUT_MS = 45_000
const MAX_ACCOUNTS = 20
const MAX_SNAPSHOTS = 64
const DEFAULT_ACCOUNTS = 10
const DEFAULT_CHAIN_ID = 31_337

export const EVM_LAB_TOOL_DEF = {
  name: "evm_lab",
  description:
    "Prepare, inspect, snapshot, revert, or stop the engagement-owned local Anvil lab. This tool adds lifecycle convenience only and does not proxy, rewrite, or restrict JSON-RPC methods.",
  inputSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["prepare", "status", "snapshot", "revert", "stop"] },
      mode: { type: "string", enum: ["fresh", "fork"] },
      repositories: {
        type: "array",
        maxItems: 8,
        items: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
      },
      fork_url: { type: "string", minLength: 1, maxLength: 4_096 },
      fork_block: { type: "integer", minimum: 0 },
      chain_id: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
      accounts: { type: "integer", minimum: 1, maximum: MAX_ACCOUNTS },
      name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
    },
    required: ["action"],
  },
} as const

interface LabAccount {
  readonly address: string
  readonly variable: string
}

interface LabState {
  readonly version: 1
  readonly lab_id: string
  readonly container: string
  readonly network?: string
  readonly mode: "fresh" | "fork"
  readonly host_rpc_url: string
  readonly container_rpc_url: string
  readonly chain_id: number
  readonly fork?: { readonly origin: string; readonly block?: number }
  readonly repositories: Awaited<ReturnType<typeof materializeSourcesForEvmLab>>
  readonly accounts: readonly LabAccount[]
  readonly baseline_snapshot: string
  readonly snapshots: Readonly<Record<string, string>>
  readonly status: "running" | "stopped"
  readonly created_at: string
  readonly stopped_at?: string
}

interface DockerResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface EvmLabHooks {
  readonly docker?: (args: readonly string[]) => Promise<DockerResult>
  readonly rpc?: (url: string, method: string, params?: readonly unknown[]) => Promise<unknown>
  readonly materialize?: typeof materializeSourcesForEvmLab
  readonly setVariable: (name: string, value: string, description: string) => void
  readonly deleteVariable: (name: string) => void
}

function workareaRoot() {
  const configured = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim()
  if (!configured || !path.isAbsolute(configured)) throw new Error("evm_lab requires an absolute workarea")
  return configured
}

function runtimeID() {
  const configured = process.env.CYBERFUL_EVM_RUNTIME_ID?.trim()
  if (!configured || !/^[a-f0-9-]{36}$/i.test(configured))
    throw new Error("evm_lab requires an engagement-owned runtime")
  return configured
}

export function evmLabAvailable() {
  return Boolean(
    process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim() && process.env.CYBERFUL_EVM_RUNTIME_ID?.trim(),
  )
}

function engagementContainer() {
  const configured = process.env.CYBERFUL_OS_CONTAINER?.trim()
  if (!configured || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(configured))
    throw new Error("evm_lab requires the engagement-owned cyberful-os container")
  return configured
}

function integer(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`)
  return value
}

function repositories(value: unknown) {
  if (value === undefined) return []
  if (
    !Array.isArray(value) ||
    value.length > 8 ||
    value.some((item) => typeof item !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(item))
  )
    throw new Error("evm_lab repositories must contain at most 8 stable aliases")
  return [...new Set(value as string[])]
}

function snapshotName(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value))
    throw new Error("evm_lab snapshot name must be a stable 1-64 character name")
  return value
}

function safeForkOrigin(value: string) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol")
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}/[redacted]`
  } catch {
    return "[redacted RPC origin]"
  }
}

async function defaultRpc(url: string, method: string, params: readonly unknown[] = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Anvil RPC returned HTTP ${response.status}`)
  const body: unknown = await response.json()
  if (!body || typeof body !== "object" || !("result" in body)) {
    const detail = body && typeof body === "object" && "error" in body ? JSON.stringify(body.error) : "invalid response"
    throw new Error(`Anvil RPC ${method} failed: ${detail}`)
  }
  return body.result
}

async function waitForRpc(url: string, rpc: NonNullable<EvmLabHooks["rpc"]>) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await rpc(url, "eth_chainId")
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  throw new Error(`Anvil did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function waitForContainerRpc(
  container: string,
  url: string,
  chainID: number,
  docker: NonNullable<EvmLabHooks["docker"]>,
) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let lastError = "no probe completed"
  while (Date.now() < deadline) {
    try {
      const result = await docker(["exec", container, "cast", "chain-id", "--rpc-url", url])
      const actualChainID = result.stdout.trim()
      if (result.exitCode === 0 && actualChainID === String(chainID)) return
      lastError = result.stderr.trim() || actualChainID || `exit code ${result.exitCode}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Anvil was not reachable from cyberful-os: ${lastError}`)
}

function runtimeIdentity() {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  const gid = typeof process.getgid === "function" ? process.getgid() : undefined
  return {
    uid: uid !== undefined && uid > 0 ? uid : 1000,
    gid: gid !== undefined && gid > 0 ? gid : 1000,
  }
}

function dockerOutput(result: DockerResult, operation: string) {
  if (result.exitCode !== 0) throw new Error(`${operation} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  return result.stdout.trim()
}

function publishedPort(value: string) {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean)
  for (const line of lines) {
    const match = /(?:127\.0\.0\.1|\[::1\]|::1):(\d+)$/.exec(line)
    const port = Number(match?.[1])
    if (Number.isInteger(port) && port > 0 && port <= 65_535) return port
  }
  throw new Error("Docker did not publish the Anvil port on loopback")
}

function parseAccounts(logs: string, expected: number) {
  const addresses = [...logs.matchAll(/\(\s*(\d+)\s*\)\s+(0x[a-fA-F0-9]{40})(?![a-fA-F0-9])/g)]
  const keys = [...logs.matchAll(/\(\s*(\d+)\s*\)\s+(0x[a-fA-F0-9]{64})(?![a-fA-F0-9])/g)]
  const byAddress = new Map(addresses.map((match) => [Number(match[1]), match[2] ?? ""]))
  const byKey = new Map(keys.map((match) => [Number(match[1]), match[2] ?? ""]))
  const result: { index: number; address: string; privateKey: string }[] = []
  for (let index = 0; index < expected; index++) {
    const address = byAddress.get(index)
    const privateKey = byKey.get(index)
    if (!address || !privateKey) throw new Error("Anvil did not disclose the expected synthetic account set")
    result.push({ index, address, privateKey })
  }
  return result
}

async function state(workarea: string): Promise<LabState | undefined> {
  const filename = path.join(workarea, STATE_PATH)
  const metadata = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!metadata) return
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024)
    throw new Error("EVM lab state is unsafe")
  const parsed: unknown = JSON.parse(await readFile(filename, "utf8"))
  if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1)
    throw new Error("EVM lab state is malformed")
  const value = parsed as LabState
  const variablePrefix = `evm_${value.lab_id?.slice(0, 8)}_account_`
  if (
    typeof value.lab_id !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(value.lab_id) ||
    value.container !== `cyberful-anvil-${value.lab_id.slice(0, 12)}` ||
    (value.network !== undefined && value.network !== `cyberful-anvil-net-${value.lab_id.slice(0, 12)}`) ||
    !Array.isArray(value.accounts) ||
    value.accounts.some(
      (account) =>
        typeof account.address !== "string" ||
        !/^0x[a-f0-9]{40}$/i.test(account.address) ||
        typeof account.variable !== "string" ||
        !account.variable.startsWith(variablePrefix) ||
        !account.variable.endsWith("_private_key"),
    )
  )
    throw new Error("EVM lab state is malformed")
  return value
}

async function writeState(workarea: string, value: LabState) {
  await replaceWorkareaFile(workarea, STATE_PATH, `${JSON.stringify(value, null, 2)}\n`)
}

async function containerStatus(container: string, owner: string, docker: NonNullable<EvmLabHooks["docker"]>) {
  const result = await docker([
    "inspect",
    "--format",
    `{{index .Config.Labels "${EVM_RUNTIME_LABEL}"}} {{.State.Running}}`,
    container,
  ])
  if (result.exitCode !== 0) return { exists: false, running: false }
  const [actualOwner, live] = result.stdout.trim().split(/\s+/, 2)
  if (actualOwner !== owner) throw new Error("EVM lab container is not owned by this engagement")
  return { exists: true, running: live === "true" }
}

async function running(container: string, owner: string, docker: NonNullable<EvmLabHooks["docker"]>) {
  return (await containerStatus(container, owner, docker)).running
}

async function remove(container: string, owner: string, docker: NonNullable<EvmLabHooks["docker"]>) {
  if (!(await containerStatus(container, owner, docker)).exists) return
  const result = await docker(["rm", "--force", "--volumes", container])
  if (result.exitCode !== 0 && !result.stderr.includes("No such container"))
    throw new Error(`Anvil cleanup failed: ${result.stderr.trim()}`)
}

async function ownedNetwork(
  network: string,
  owner: string,
  docker: NonNullable<EvmLabHooks["docker"]>,
) {
  const inspected = await docker([
    "network",
    "inspect",
    "--format",
    `{{index .Labels "${EVM_RUNTIME_LABEL}"}}`,
    network,
  ])
  if (inspected.exitCode !== 0) {
    if (inspected.stderr.includes("No such network")) return false
    throw new Error(`Anvil network inspection failed: ${inspected.stderr.trim()}`)
  }
  if (inspected.stdout.trim() !== owner) throw new Error("EVM lab network is not owned by this engagement")
  return true
}

async function disconnectNetwork(
  network: string | undefined,
  container: string,
  owner: string,
  docker: NonNullable<EvmLabHooks["docker"]>,
) {
  if (!network || !(await ownedNetwork(network, owner, docker))) return
  const disconnected = await docker(["network", "disconnect", "--force", network, container])
  if (
    disconnected.exitCode !== 0 &&
    !disconnected.stderr.includes("No such network") &&
    !disconnected.stderr.includes("is not connected to network")
  )
    throw new Error(`Cyberful core EVM network disconnection failed: ${disconnected.stderr.trim()}`)
}

async function removeNetwork(network: string | undefined, owner: string, docker: NonNullable<EvmLabHooks["docker"]>) {
  if (!network || !(await ownedNetwork(network, owner, docker))) return
  const removed = await docker(["network", "rm", network])
  if (removed.exitCode !== 0 && !removed.stderr.includes("No such network"))
    throw new Error(`Anvil network cleanup failed: ${removed.stderr.trim()}`)
}

async function removeLabResources(
  container: string,
  network: string | undefined,
  coreContainer: string,
  owner: string,
  docker: NonNullable<EvmLabHooks["docker"]>,
) {
  const failures: unknown[] = []
  try {
    await remove(container, owner, docker)
  } catch (error) {
    failures.push(error)
  }
  try {
    await disconnectNetwork(network, coreContainer, owner, docker)
  } catch (error) {
    failures.push(error)
  }
  try {
    await removeNetwork(network, owner, docker)
  } catch (error) {
    failures.push(error)
  }
  if (failures.length > 0) throw new AggregateError(failures, "EVM lab cleanup failed")
}

function publicState(value: LabState, live: boolean) {
  return {
    lab_id: value.lab_id,
    status: live ? "running" : "stopped",
    mode: value.mode,
    host_rpc_url: value.host_rpc_url,
    container_rpc_url: value.container_rpc_url,
    chain_id: value.chain_id,
    fork: value.fork,
    repositories: value.repositories,
    accounts: value.accounts,
    baseline_snapshot: value.baseline_snapshot,
    snapshots: value.snapshots,
    created_at: value.created_at,
    stopped_at: value.stopped_at,
  }
}

export async function handleEvmLab(args: Record<string, unknown>, hooks: EvmLabHooks) {
  const workarea = await realpath(workareaRoot())
  const owner = runtimeID()
  const docker = hooks.docker ?? dockerCommand
  const rpc = hooks.rpc ?? defaultRpc
  const materialize = hooks.materialize ?? materializeSourcesForEvmLab
  const current = await state(workarea)

  if (args.action === "status") {
    if (!current) return { status: "not-prepared" }
    return publicState(current, await running(current.container, owner, docker))
  }

  if (args.action === "stop") {
    if (!current) return { stopped: false, status: "not-prepared" }
    const coreContainer = engagementContainer()
    await removeLabResources(current.container, current.network, coreContainer, owner, docker)
    for (const account of current.accounts) hooks.deleteVariable(account.variable)
    await rm(path.join(workarea, ".cyberful-evm", "projects", current.lab_id), { recursive: true, force: true })
    const stopped: LabState = { ...current, status: "stopped", stopped_at: new Date().toISOString() }
    await writeState(workarea, stopped)
    return { stopped: true, lab_id: current.lab_id }
  }

  if (args.action === "snapshot") {
    if (!current || !(await running(current.container, owner, docker))) throw new Error("evm_lab has no running managed chain")
    const name = snapshotName(args.name)
    if (name in current.snapshots) throw new Error(`EVM snapshot '${name}' already exists`)
    if (Object.keys(current.snapshots).length >= MAX_SNAPSHOTS)
      throw new Error(`evm_lab supports at most ${MAX_SNAPSHOTS} named snapshots`)
    const id = String(await rpc(current.host_rpc_url, "evm_snapshot"))
    const next: LabState = { ...current, snapshots: { ...current.snapshots, [name]: id } }
    await writeState(workarea, next)
    return { name, snapshot: id }
  }

  if (args.action === "revert") {
    if (!current || !(await running(current.container, owner, docker))) throw new Error("evm_lab has no running managed chain")
    const name = snapshotName(args.name)
    const id = name === "baseline" ? current.baseline_snapshot : current.snapshots[name]
    if (!id) throw new Error(`EVM snapshot '${name}' does not exist`)
    const reverted = await rpc(current.host_rpc_url, "evm_revert", [id])
    if (reverted !== true) throw new Error(`Anvil rejected revert to snapshot '${name}'`)
    const refreshed = String(await rpc(current.host_rpc_url, "evm_snapshot"))
    const next: LabState =
      name === "baseline"
        ? { ...current, baseline_snapshot: refreshed }
        : { ...current, snapshots: { ...current.snapshots, [name]: refreshed } }
    await writeState(workarea, next)
    return { reverted: true, name, snapshot: refreshed }
  }

  if (args.action !== "prepare") throw new Error("evm_lab action must be prepare, status, snapshot, revert, or stop")
  const coreContainer = engagementContainer()
  if (current && (await running(current.container, owner, docker))) throw new Error("an EVM lab is already running")
  if (current) {
    await removeLabResources(current.container, current.network, coreContainer, owner, docker)
    for (const account of current.accounts) hooks.deleteVariable(account.variable)
    await rm(path.join(workarea, ".cyberful-evm", "projects", current.lab_id), { recursive: true, force: true })
  }

  const mode = args.mode === undefined ? "fresh" : args.mode
  if (mode !== "fresh" && mode !== "fork") throw new Error("evm_lab mode must be fresh or fork")
  const forkUrl = typeof args.fork_url === "string" && args.fork_url.trim() ? args.fork_url.trim() : undefined
  if (mode === "fork" && !forkUrl) throw new Error("evm_lab fork mode requires fork_url")
  if (mode === "fresh" && (forkUrl || args.fork_block !== undefined))
    throw new Error("evm_lab fresh mode does not accept fork_url or fork_block")
  const forkBlock = args.fork_block === undefined ? undefined : integer(args.fork_block, "fork_block", 0, Number.MAX_SAFE_INTEGER)
  const chainID = args.chain_id === undefined ? DEFAULT_CHAIN_ID : integer(args.chain_id, "chain_id", 1, 2_147_483_647)
  const accountCount = args.accounts === undefined ? DEFAULT_ACCOUNTS : integer(args.accounts, "accounts", 1, MAX_ACCOUNTS)
  const labID = randomUUID()
  const container = `cyberful-anvil-${labID.slice(0, 12)}`
  const network = `cyberful-anvil-net-${labID.slice(0, 12)}`
  const destination = path.join(workarea, ".cyberful-evm", "projects", labID)
  const selectedRepositories = repositories(args.repositories)
  const projects = await materialize(destination, selectedRepositories)
  const image = process.env.CYBERFUL_OS_IMAGE?.trim() || "cyberful-os:latest"
  const identity = runtimeIdentity()
  const labels = [
    ...dockerOwnershipLabels({ managed: "evm", runtime: "evm", session: process.env.CYBERFUL_SUBSYSTEM_SESSION ?? "unknown" }),
    `${EVM_RUNTIME_LABEL}=${owner}`,
  ]
  // ── EVM Networks Borrow The Core Container ─────────────────────────────────
  // A host port bound to loopback cannot be reached through Docker's host gateway
  // on native Linux. Every lab therefore owns a user-defined bridge and temporarily
  // joins the engagement core to it, giving Cast a private DNS route to Anvil while
  // retaining the separate loopback route used by the host gateway. Fresh bridges
  // disable masquerading; fork bridges keep egress only for their selected RPC.
  // ─────────────────────────────────────────────────────────────────────────────
  const command = [
    "run",
    "--detach",
    "--rm",
    "--pull=never",
    "--name",
    container,
    ...labels.flatMap((label) => ["--label", label]),
    "--network",
    network,
    ...(mode === "fork" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
    "--publish",
    "127.0.0.1::8545",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=512",
    "--read-only",
    "--user",
    `${identity.uid}:${identity.gid}`,
    "--env",
    "HOME=/tmp",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m",
    "--entrypoint",
    "anvil",
    image,
    "--color",
    "never",
    "--host",
    "0.0.0.0",
    "--port",
    "8545",
    "--accounts",
    String(accountCount),
    "--chain-id",
    String(chainID),
    "--mnemonic-seed-unsafe",
    randomBytes(8).readBigUInt64BE().toString(10),
    ...(mode === "fork" ? ["--fork-url", forkUrl ?? ""] : []),
    ...(forkBlock === undefined ? [] : ["--fork-block-number", String(forkBlock)]),
  ]

  const variableNames: string[] = []
  let containerStarted = false
  try {
    dockerOutput(
      await docker([
        "network",
        "create",
        "--driver",
        "bridge",
        ...(mode === "fresh"
          ? ["--opt", "com.docker.network.bridge.enable_ip_masquerade=false"]
          : []),
        ...labels.flatMap((label) => ["--label", label]),
        network,
      ]),
      "Anvil network start",
    )
    dockerOutput(await docker(command), "Anvil container start")
    containerStarted = true
    const port = publishedPort(dockerOutput(await docker(["port", container, "8545/tcp"]), "Anvil port discovery"))
    const hostRpcUrl = `http://127.0.0.1:${port}`
    await waitForRpc(hostRpcUrl, rpc)
    const containerRpcUrl = `http://${container}:8545`
    dockerOutput(
      await docker(["network", "connect", network, coreContainer]),
      "Cyberful core EVM network connection",
    )
    await waitForContainerRpc(coreContainer, containerRpcUrl, chainID, docker)
    const logs = dockerOutput(await docker(["logs", container]), "Anvil account discovery")
    const accounts = parseAccounts(logs, accountCount).map((account) => {
      const variable = `evm_${labID.slice(0, 8)}_account_${account.index}_private_key`
      hooks.setVariable(variable, account.privateKey, `${EVM_VARIABLE_DESCRIPTION_PREFIX}${owner}`)
      variableNames.push(variable)
      return { address: account.address, variable }
    })
    const baseline = String(await rpc(hostRpcUrl, "evm_snapshot"))
    const next: LabState = {
      version: 1,
      lab_id: labID,
      container,
      network,
      mode,
      host_rpc_url: hostRpcUrl,
      container_rpc_url: containerRpcUrl,
      chain_id: chainID,
      ...(mode === "fork" ? { fork: { origin: safeForkOrigin(forkUrl ?? ""), ...(forkBlock === undefined ? {} : { block: forkBlock }) } } : {}),
      repositories: projects,
      accounts,
      baseline_snapshot: baseline,
      snapshots: {},
      status: "running",
      created_at: new Date().toISOString(),
    }
    await writeState(workarea, next)
    return publicState(next, true)
  } catch (error) {
    const logs = containerStarted
      ? await docker(["logs", "--tail", "200", container]).catch(() => undefined)
      : undefined
    for (const name of variableNames) hooks.deleteVariable(name)
    const cleanupFailures: unknown[] = []
    try {
      await removeLabResources(container, network, coreContainer, owner, docker)
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError)
    }
    try {
      await rm(destination, { recursive: true, force: true })
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError)
    }
    if (cleanupFailures.length > 0)
      throw new AggregateError([error, ...cleanupFailures], "Anvil startup and cleanup failed")
    const detail = logs && logs.exitCode === 0
      ? forkUrl
        ? logs.stdout.trim().replaceAll(forkUrl, "[redacted fork URL]")
        : logs.stdout.trim()
      : ""
    if (detail)
      throw new Error(
        `Anvil preparation failed: ${error instanceof Error ? error.message : String(error)}\nAnvil logs:\n${detail}`,
        { cause: error },
      )
    throw error
  }
}
