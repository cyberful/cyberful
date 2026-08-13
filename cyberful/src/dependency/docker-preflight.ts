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
import { Global } from "@/global"
import fs from "node:fs"
import path from "node:path"
import {
  cyberfulOsBuildCommand,
  cyberfulOsDir,
  cyberfulOsImage,
  cyberfulOsImageIsManaged,
  cyberfulOsRuntimeFingerprint,
  validateUnifiedRuntimeEnvironment,
} from "./config"

const log = Log.create({ service: "docker-preflight" })
const DOCKER_COMMAND_TIMEOUT_MS = 30_000
const DOCKER_BUILD_TIMEOUT_MS = 6 * 60 * 60_000
const DOCKER_PULL_TIMEOUT_MS = 2 * 60 * 60_000
const DOCKER_VERIFY_TIMEOUT_MS = 2 * 60_000
const DOCKER_OUTPUT_LIMIT_BYTES = 1024 * 1024
const DOCKER_KILL_GRACE_MS = 1_000
const MINIMUM_BUILD_FREE_BYTES = 100 * 1024 ** 3
const IMAGE_STATE_PATH = path.join(Global.Path.state, "runtime-images.json")
const BUILD_LOCK_PATH = path.join(Global.Path.state, "runtime-build.lock")

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

async function runLogged(command: string[], logPath: string, timeoutMs: number): Promise<number | null> {
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 })
  const handle = fs.openSync(logPath, "a", 0o600)
  fs.writeSync(handle, `\n[${new Date().toISOString()}] ${command.join(" ")}\n`)
  try {
    const proc = Bun.spawn(command, {
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    })
    const forward = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        fs.writeSync(handle, chunk)
        process.stderr.write(chunk)
      }
    }
    const [, , code] = await Promise.all([forward(proc.stdout), forward(proc.stderr), proc.exited])
    return code
  } catch {
    return null
  } finally {
    fs.closeSync(handle)
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

function processAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isRecord(error) && error.code === "EPERM"
  }
}

async function acquireBuildLock(): Promise<() => void> {
  fs.mkdirSync(path.dirname(BUILD_LOCK_PATH), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + DOCKER_BUILD_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(BUILD_LOCK_PATH, { mode: 0o700 })
      fs.writeFileSync(path.join(BUILD_LOCK_PATH, "owner.json"), JSON.stringify({ pid: process.pid, started_at: Date.now() }), {
        mode: 0o600,
      })
      return () => fs.rmSync(BUILD_LOCK_PATH, { recursive: true, force: true })
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(BUILD_LOCK_PATH, "owner.json"), "utf8")) as unknown
        if (!isRecord(owner) || typeof owner.pid !== "number" || !processAlive(owner.pid)) {
          fs.rmSync(BUILD_LOCK_PATH, { recursive: true, force: true })
          continue
        }
      } catch {
        fs.rmSync(BUILD_LOCK_PATH, { recursive: true, force: true })
        continue
      }
      await Bun.sleep(500)
    }
  }
  throw new Error("Timed out waiting for another Cyberful runtime build to finish.")
}

function requireBuildDiskSpace(context: string) {
  const stats = fs.statfsSync(context)
  const available = stats.bavail * stats.bsize
  if (available >= MINIMUM_BUILD_FREE_BYTES) return
  throw new Error(
    `Building cyberful-os requires at least 100 GB free; ${(available / 1024 ** 3).toFixed(1)} GB is available.`,
  )
}

function readManagedHistory(): string[] {
  try {
    const value = JSON.parse(fs.readFileSync(IMAGE_STATE_PATH, "utf8")) as unknown
    if (!isRecord(value) || !Array.isArray(value.images)) return []
    return value.images.filter((item): item is string => typeof item === "string" && /^cyberful-os:runtime-[a-f0-9]{64}$/.test(item))
  } catch {
    return []
  }
}

async function retainCurrentAndPrevious(image: string) {
  const images = [image, ...readManagedHistory().filter((item) => item !== image)]
  fs.mkdirSync(path.dirname(IMAGE_STATE_PATH), { recursive: true, mode: 0o700 })
  const temporary = `${IMAGE_STATE_PATH}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, images: images.slice(0, 2) }, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, IMAGE_STATE_PATH)
  for (const stale of images.slice(2)) {
    const code = await runExitCode(["docker", "image", "rm", stale])
    if (code !== 0) log.warn("could not remove stale managed runtime image", { image: stale, code })
  }
}

async function imageAttested(image: string, stream = false, fingerprint?: string) {
  const runtimeReady =
    (await runExitCode(["docker", "run", "--rm", "--entrypoint", "/opt/cyberful/runtime-attestation", image], {
      stream,
      timeoutMs: DOCKER_VERIFY_TIMEOUT_MS,
    })) === 0
  if (!runtimeReady || !fingerprint) return runtimeReady
  return (
    (await runText([
      "docker",
      "image",
      "inspect",
      "--format",
      '{{index .Config.Labels "org.cyberful.runtime-fingerprint"}}',
      image,
    ])) === fingerprint
  )
}

async function buildManagedRuntime(image: string, fingerprint: string, context: string, force = false) {
  requireBuildDiskSpace(context)
  const release = await acquireBuildLock()
  const candidate = `cyberful-os:build-${fingerprint}-${process.pid}`
  try {
    if (!force && (await runExitCode(["docker", "image", "inspect", image])) === 0 && (await imageAttested(image, false, fingerprint))) return
    const base = cyberfulOsBuildCommand(candidate)
    const command = [
      ...base.slice(0, -3),
      "--build-arg",
      `CYBERFUL_RUNTIME_FINGERPRINT=${fingerprint}`,
      ...base.slice(-3),
    ]
    const buildLog = path.join(Global.Path.log, `runtime-build-${fingerprint}.log`)
    line(dim(`    Persistent build log: ${buildLog}`))
    const prepared = await runLogged(command, buildLog, DOCKER_BUILD_TIMEOUT_MS)
    if (prepared !== 0) throw new Error(`Local cyberful-os build failed with exit ${prepared ?? "spawn error"}.`)
    if (!(await imageAttested(candidate, true, fingerprint))) throw new Error("The locally built cyberful-os image failed attestation.")
    if ((await runExitCode(["docker", "tag", candidate, image])) !== 0) throw new Error("Could not publish the local runtime tag.")
    await retainCurrentAndPrevious(image)
  } finally {
    await runExitCode(["docker", "image", "rm", candidate])
    release()
  }
}

export async function runtimeStatus() {
  const image = cyberfulOsImage()
  const exists = (await runExitCode(["docker", "image", "inspect", image])) === 0
  const fingerprint = cyberfulOsRuntimeFingerprint()
  const attested = exists && (await imageAttested(image, false, cyberfulOsImageIsManaged() ? fingerprint : undefined))
  const identity = exists
    ? await runText([
        "docker",
        "image",
        "inspect",
        "--format",
        "{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels \"org.cyberful.runtime-fingerprint\"}}",
        image,
      ])
    : ""
  return {
    image,
    managed: cyberfulOsImageIsManaged(),
    fingerprint: fingerprint ?? null,
    exists,
    attested,
    identity: identity || null,
    retained: readManagedHistory(),
  }
}

export async function buildRuntime(force = false) {
  await requireDockerDaemon()
  const image = cyberfulOsImage()
  const fingerprint = cyberfulOsRuntimeFingerprint()
  const context = cyberfulOsDir()
  if (!fingerprint || !cyberfulOsImageIsManaged() || !context)
    throw new Error("Explicit runtime builds require a packaged Cyberful runtime context without CYBERFUL_OS_IMAGE.")
  await buildManagedRuntime(image, fingerprint, context, force)
  return runtimeStatus()
}

export async function pruneRuntimeImages() {
  await requireDockerDaemon()
  const retained = readManagedHistory().slice(0, 2)
  const listed = await runText([
    "docker",
    "image",
    "ls",
    "--filter",
    "label=org.cyberful.managed-runtime=true",
    "--format",
    "{{.Repository}}:{{.Tag}}",
  ])
  const candidates = listed
    .split("\n")
    .filter((item) => item && !retained.includes(item) && item !== "<none>:<none>")
  const removed: string[] = []
  const preserved: string[] = []
  for (const candidate of candidates) {
    if ((await runExitCode(["docker", "image", "rm", candidate])) === 0) removed.push(candidate)
    else preserved.push(candidate)
  }
  return { retained, removed, preserved }
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
  const networks = (await runText(["docker", "network", "ls", "--quiet", "--filter", "label=org.cyberful.managed"]))
    .split("\n")
    .filter(Boolean)
  for (const network of networks) {
    const owner = await runText([
      "docker",
      "network",
      "inspect",
      "--format",
      '{{ index .Labels "org.cyberful.owner-pid" }}',
      network,
    ])
    if (processIsAlive(owner)) continue
    const code = await runExitCode(["docker", "network", "rm", network])
    if (code === 0) removed++
    else log.warn("failed to remove orphaned managed network", { network, code })
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
  if (reaped > 0) line(`  ${green("✓")} removed ${reaped} orphaned Cyberful Docker resource${reaped === 1 ? "" : "s"}`)

  const image = cyberfulOsImage()
  const fingerprint = cyberfulOsRuntimeFingerprint()
  const verify = ["docker", "run", "--rm", "--entrypoint", "/opt/cyberful/runtime-attestation", image]

  // ── Releases And Source Runs Both Build Locally ───────────────────────
  // A compiled CLI materializes its complete fingerprinted Docker context and
  // builds a managed local tag. Source checkouts retain cyberful-os:latest for
  // contributor iteration. Explicit operator images remain pullable overrides.
  // Every path converges on the same in-image attestation before startup.
  // ─────────────────────────────────────────────────────────────────
  const exists = (await runExitCode(["docker", "image", "inspect", image])) === 0
  const attested =
    exists &&
    (await imageAttested(image, false, cyberfulOsImageIsManaged() ? fingerprint : undefined))
  if (!attested) {
    const managedLocalImage = cyberfulOsImageIsManaged() && fingerprint
    const localSourceImage = image === "cyberful-os:latest"
    const command = localSourceImage ? cyberfulOsBuildCommand(image) : ["docker", "pull", image]
    const cwd = localSourceImage ? cyberfulOsDir() : undefined
    if (managedLocalImage) {
      const context = cyberfulOsDir()
      if (!context) throw new Error("The embedded cyberful-os build context is unavailable.")
      line(
        `  ${yellow("⏳")} unified runtime ${dim(`(${image})`)} ${exists ? "failed attestation" : "not found"} — building locally…`,
      )
      line(dim("    Docker build output follows. The first build needs at least 100 GB free and may take several hours."))
      await buildManagedRuntime(image, fingerprint, context)
    } else if (command.length === 0 || (localSourceImage && !cwd)) {
      line(`  ${red("✗")} unified runtime build context is unavailable`)
      throw new Error("The unified cyberful-os build context is unavailable; startup cannot continue safely.")
    } else {
      line(
        `  ${yellow("⏳")} unified runtime ${dim(`(${image})`)} ${exists ? "failed attestation" : "not found"} — ${localSourceImage ? "building" : "pulling"}…`,
      )
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
    '{{.Os}}/{{.Architecture}} {{join .RepoDigests ","}}',
    image,
  ])
  line(`  ${green("✓")} unified runtime ready ${dim(`(${image}${identity ? `; ${identity}` : ""})`)}`)
  line()
}

export * as DockerPreflight from "./docker-preflight"
