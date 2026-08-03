// ── Container Runtime Preflight ──────────────────────────────────
// Verifies the Docker daemon, reaps orphaned managed containers, and prepares
// the single first-party engagement image before a session can be created.
// → cyberful/src/dependency/config.ts — defines enabled runtimes and pinned image policy.
// → cyberful/src/subsystem/engagement-runtime.ts — starts the image accepted here.
// @docs/getting-started/requirements.md
// ─────────────────────────────────────────────────────────────────
import * as Log from "@/util/log"
import { Process } from "@/util/process"
import { isRecord } from "@/util/record"
import {
  cyberfulOsBuildCommand,
  cyberfulOsDir,
  cyberfulOsImage,
  validateUnifiedRuntimeEnvironment,
} from "./config"

const log = Log.create({ service: "docker-preflight" })
const DOCKER_COMMAND_TIMEOUT_MS = 30_000
const DOCKER_BUILD_TIMEOUT_MS = 3 * 60 * 60_000
const DOCKER_PULL_TIMEOUT_MS = 2 * 60 * 60_000
const DOCKER_VERIFY_TIMEOUT_MS = 2 * 60_000
const DOCKER_OUTPUT_LIMIT_BYTES = 1024 * 1024
const DOCKER_KILL_GRACE_MS = 1_000

const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR
const paint = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = (t: string) => paint("2", t)
const green = (t: string) => paint("32", t)
const yellow = (t: string) => paint("33", t)
const red = (t: string) => paint("31", t)

function line(text = "") {
  process.stderr.write(text + "\n")
}

async function runExitCode(
  command: string[],
  options: { stream?: boolean; cwd?: string; timeoutMs?: number } = {},
): Promise<number | null> {
  try {
    const proc = Bun.spawn(command, {
      cwd: options.cwd,
      env: process.env,
      stdin: "ignore",
      stdout: options.stream ? "inherit" : "ignore",
      stderr: options.stream ? "inherit" : "ignore",
      timeout: options.timeoutMs ?? DOCKER_COMMAND_TIMEOUT_MS,
    })
    return await proc.exited
  } catch {
    return null
  }
}

export async function requireDockerDaemon(
  run: (command: string[]) => Promise<number | null> = (command) => runExitCode(command),
): Promise<void> {
  if ((await run(["docker", "version", "--format", "{{.Server.Version}}"])) === 0) return
  throw new Error(
    "Docker is required but its daemon is not reachable. Start Docker Desktop (or the configured Docker daemon) and relaunch Cyberful.",
  )
}

async function runText(command: string[]) {
  const result = await Process.text(command, {
    nothrow: true,
    maxOutputBytes: DOCKER_OUTPUT_LIMIT_BYTES,
    abort: AbortSignal.timeout(DOCKER_COMMAND_TIMEOUT_MS),
    timeout: DOCKER_KILL_GRACE_MS,
  })
  return result.code === 0 ? result.text.trim() : ""
}

function processIsAlive(value: string) {
  const pid = Number.parseInt(value, 10)
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === "ESRCH") return false
    if (isRecord(error) && error.code === "EPERM") return true
    log.warn("could not verify container owner process; preserving its containers", { error, pid })
    return true
  }
}

async function reapOrphanedManagedContainers() {
  const containers = (await runText(["docker", "ps", "--all", "--quiet", "--filter", "label=org.cyberful.managed"]))
    .split("\n")
    .filter(Boolean)
  const orphaned: string[] = []
  for (const container of containers) {
    const owner = await runText([
      "docker",
      "inspect",
      "--format",
      '{{ index .Config.Labels "org.cyberful.owner-pid" }}',
      container,
    ])
    if (!processIsAlive(owner)) orphaned.push(container)
  }

  let removed = 0
  for (const container of orphaned) {
    const code = await runExitCode(["docker", "rm", "--force", "--volumes", container])
    if (code === 0) removed++
    else log.warn("failed to remove orphaned managed container", { container, code })
  }
  return removed
}

export async function runDockerPreflight(): Promise<void> {
  validateUnifiedRuntimeEnvironment()

  line()
  line(dim("Cyberful preflight — preparing container images"))

  // ── Enabled Container Capabilities Fail Before Session Creation ───
  // The preflight runs in the main process before the TUI owns the terminal, so
  // image progress remains visible without corrupting a protocol stream. Merely
  // finding the Docker client is insufficient: the server-version probe proves
  // the daemon is reachable. Enabled images must then exist and, when required,
  // pass capability attestation; otherwise startup stops before creating state
  // for an engagement that could not execute its promised tools.
  // ─────────────────────────────────────────────────────────────────
  try {
    await requireDockerDaemon()
  } catch (error) {
    line(`  ${red("✗")} Docker daemon not reachable`)
    line(dim("    Start Docker Desktop (or the configured Docker daemon) and relaunch Cyberful."))
    log.warn("preflight: docker daemon not reachable")
    line()
    throw error
  }
  line(`  ${green("✓")} Docker daemon reachable`)

  const reaped = await reapOrphanedManagedContainers()
  if (reaped > 0)
    line(`  ${green("✓")} removed ${reaped} orphaned Cyberful container${reaped === 1 ? "" : "s"}`)

  const image = cyberfulOsImage()
  const verify = ["docker", "run", "--rm", "--entrypoint", "/opt/cyberful/runtime-attestation", image]

  // ── Releases Pull One Immutable Index; Source Builds One Image ─────────
  // A compiled CLI carries a GHCR index digest and never reconstructs its runtime
  // from partial embedded Docker contexts. Source checkouts retain the local
  // cyberful-os:latest build path for contributors. Both paths converge on the
  // same in-image attestation before startup, and pull/build output remains on the
  // terminal so a multi-gigabyte first download is never mistaken for a hang.
  // ─────────────────────────────────────────────────────────────────
  const exists = (await runExitCode(["docker", "image", "inspect", image])) === 0
  const attested = exists && (await runExitCode(verify, { timeoutMs: DOCKER_VERIFY_TIMEOUT_MS })) === 0
  if (!attested) {
    const localSourceImage = image === "cyberful-os:latest"
    const command = localSourceImage ? cyberfulOsBuildCommand() : ["docker", "pull", image]
    const cwd = localSourceImage ? cyberfulOsDir() : undefined
    if (command.length === 0 || (localSourceImage && !cwd)) {
      line(`  ${red("✗")} unified runtime build context is unavailable`)
      throw new Error("The unified cyberful-os build context is unavailable; startup cannot continue safely.")
    }
    line(
      `  ${yellow("⏳")} unified runtime ${dim(`(${image})`)} ${
        exists ? "failed attestation" : "not found"
      } — ${localSourceImage ? "building" : "pulling"}…`,
    )
    if (!localSourceImage) line(dim("    First download may exceed 6 GB; keep at least 40 GB of disk space free."))
    const prepared = await runExitCode(command, {
      stream: true,
      ...(cwd ? { cwd } : {}),
      timeoutMs: localSourceImage ? DOCKER_BUILD_TIMEOUT_MS : DOCKER_PULL_TIMEOUT_MS,
    })
    if (prepared !== 0) {
      line(`  ${red("✗")} unified runtime preparation failed ${dim(`(exit ${prepared ?? "spawn error"})`)}`)
      throw new Error("The unified cyberful-os image could not be prepared; startup cannot continue safely.")
    }
  }
  if ((await runExitCode(verify, { stream: true, timeoutMs: DOCKER_VERIFY_TIMEOUT_MS })) !== 0) {
    line(`  ${red("✗")} unified runtime capability attestation failed`)
    throw new Error("The unified cyberful-os image is incomplete; startup cannot continue safely.")
  }
  const identity = await runText([
    "docker",
    "image",
    "inspect",
    "--format",
    "{{.Os}}/{{.Architecture}} {{join .RepoDigests \",\"}}",
    image,
  ])
  line(`  ${green("✓")} unified runtime ready ${dim(`(${image}${identity ? `; ${identity}` : ""})`)}`)
  line()
}

export * as DockerPreflight from "./docker-preflight"
