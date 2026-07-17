// ── Container Runtime Preflight ──────────────────────────────────
// Verifies the Docker daemon, reaps orphaned managed containers, and prepares
// every enabled first-party image before a Cyberful session can be created.
// → cyberful/src/dependency/config.ts — defines enabled runtimes and pinned image policy.
// → cyberful/src/dependency/startup.ts — starts the images accepted here.
// @docs/getting-started/requirements.md
// ─────────────────────────────────────────────────────────────────
import * as Log from "@/util/log"
import { Process } from "@/util/process"
import { isRecord } from "@/util/record"
import {
  cyberfulOsBuildCommand,
  cyberfulOsDir,
  cyberfulOsImage,
  cyberZapBridgeBuildCommand,
  cyberZapBridgeImage,
  cyberZapBuildCommand,
  cyberZapDir,
  cyberZapImage,
  shouldEnableCyberZap,
  shouldStartCyberfulOs,
} from "./config"

const log = Log.create({ service: "docker-preflight" })
const DOCKER_COMMAND_TIMEOUT_MS = 30_000
const DOCKER_BUILD_TIMEOUT_MS = 15 * 60_000
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
  if (!shouldStartCyberfulOs() && !shouldEnableCyberZap()) return
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

async function reapOrphanedZapContainers() {
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
  if (!shouldStartCyberfulOs() && !shouldEnableCyberZap()) return

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

  const reaped = await reapOrphanedZapContainers()
  if (reaped > 0) line(`  ${green("✓")} removed ${reaped} orphaned ZAP container${reaped === 1 ? "" : "s"}`)

  const images: { name: string; image: string; command: string[]; cwd?: string; verify?: string[] }[] = [
    ...(shouldStartCyberfulOs()
      ? [
          {
            name: "cyberful-os",
            image: cyberfulOsImage(),
            command: cyberfulOsBuildCommand(),
            cwd: cyberfulOsDir(),
            verify: [
              "docker",
              "run",
              "--rm",
              "--entrypoint",
              "python3",
              cyberfulOsImage(),
              "/opt/cyberful-os/cyberful_os_mcp.py",
              "--verify-capabilities",
            ],
          },
        ]
      : []),
    ...(shouldEnableCyberZap()
      ? [
          { name: "OWASP ZAP", image: cyberZapImage(), command: cyberZapBuildCommand(), cwd: cyberZapDir() },
          {
            name: "ZAP MCP bridge",
            image: cyberZapBridgeImage(),
            command: cyberZapBridgeBuildCommand(),
            cwd: cyberZapDir(),
          },
        ]
      : []),
  ]

  // ── Parallel Image Preparation Retains Every Child ──────────────
  // Independent images may build concurrently, but one early failure must not
  // let the preflight return while sibling Docker commands still own inherited
  // terminal streams. Settling the complete batch keeps every child attached to
  // this startup boundary, then reports all failures after their exits are known.
  // ─────────────────────────────────────────────────────────────────
  const outcomes = await Promise.allSettled(
    images.map(async (item) => {
      const exists = (await runExitCode(["docker", "image", "inspect", item.image])) === 0
      const attested =
        !item.verify || (exists && (await runExitCode(item.verify, { timeoutMs: DOCKER_VERIFY_TIMEOUT_MS })) === 0)
      if (exists && attested) {
        line(`  ${green("✓")} ${item.name} image ready ${dim(`(${item.image})`)}`)
        return
      }
      if (exists && !attested) {
        line(`  ${yellow("⏳")} ${item.name} image is stale or incomplete ${dim(`(${item.image})`)} — rebuilding…`)
      }
      if (!item.command.length || !item.cwd) {
        line(`  ${red("✗")} ${item.name} build context is unavailable`)
        log.warn("preflight: image build context unavailable", { image: item.image })
        throw new Error(`${item.name} build context is unavailable; startup cannot continue safely.`)
      }
      if (!exists) line(`  ${yellow("⏳")} ${item.name} image ${dim(`(${item.image})`)} not found — building…`)
      const built = await runExitCode(item.command, {
        stream: true,
        cwd: item.cwd,
        timeoutMs: DOCKER_BUILD_TIMEOUT_MS,
      })
      if (built !== 0) {
        line(`  ${red("✗")} ${item.name} image build failed ${dim(`(exit ${built ?? "spawn error"})`)}`)
        log.warn("preflight: image build failed", { name: item.name, image: item.image, code: built })
        throw new Error(`${item.name} image build failed; startup cannot continue safely.`)
      }
      if (
        item.verify &&
        (await runExitCode(item.verify, { stream: true, timeoutMs: DOCKER_VERIFY_TIMEOUT_MS })) !== 0
      ) {
        line(`  ${red("✗")} ${item.name} capability attestation failed after rebuild`)
        throw new Error(`${item.name} is missing required tools or libraries; startup cannot continue safely.`)
      }
      line(`  ${green("✓")} ${item.name} image ready ${dim(`(${item.image})`)}`)
    }),
  )
  const failures = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []))
  if (failures.length > 0) throw new AggregateError(failures, "one or more container images failed preflight")
  line()
}

export * as DockerPreflight from "./docker-preflight"
