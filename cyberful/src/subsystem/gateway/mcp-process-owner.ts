// ── Gateway MCP Process Ownership ────────────────────────────────
// Captures the exact process trees spawned by one phase gateway and reaps only
//   identities that survive their SDK clients' normal close.
// → cyberful/src/subsystem/gateway/server.ts — registers upstream transport PIDs.
// ─────────────────────────────────────────────────────────────────

export interface OwnedProcessIdentity {
  readonly pid: number
  readonly ppid: number
  readonly started: string
  readonly command: string
}

export interface OwnedProcessCleanup {
  readonly survivedClose: readonly OwnedProcessIdentity[]
  readonly forceKilled: readonly OwnedProcessIdentity[]
  readonly remaining: readonly OwnedProcessIdentity[]
}

interface ProcessOwnerHooks {
  readonly snapshot?: () => Promise<readonly OwnedProcessIdentity[]>
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void
  readonly wait?: (milliseconds: number) => Promise<void>
  readonly onSurvivors?: (processes: readonly OwnedProcessIdentity[]) => void | Promise<void>
}

function parseProcessLine(line: string): OwnedProcessIdentity | undefined {
  const match = line.match(
    /^\s*([0-9]+)\s+([0-9]+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+[ 0-9][0-9]\s+[0-9:]{8}\s+[0-9]{4})\s+(.+)$/,
  )
  if (!match) return
  const pid = Number(match[1])
  const ppid = Number(match[2])
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) return
  return { pid, ppid, started: match[3]!.replace(/\s+/g, " ").trim(), command: match[4]!.trim() }
}

export async function processSnapshot(): Promise<readonly OwnedProcessIdentity[]> {
  if (process.platform === "win32") return []
  const child = Bun.spawn(["ps", "-axo", "pid=,ppid=,lstart=,command="], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`Could not inventory MCP processes: ${stderr.trim() || `ps exit ${exitCode}`}`)
  return stdout
    .split("\n")
    .map(parseProcessLine)
    .filter((entry): entry is OwnedProcessIdentity => entry !== undefined)
}

// ── Descendant Proof Is Captured Before SDK Teardown ─────────────
// Once an MCP root exits, an orphan can be reparented and its original ownership
// is no longer derivable from PPID. Snapshot roots and descendants first, retain
// their immutable start stamp and command, and later signal only exact identity
// matches. A recycled PID or a sibling run therefore cannot match this evidence.
// ─────────────────────────────────────────────────────────────────
export function ownedProcessTree(
  snapshot: readonly OwnedProcessIdentity[],
  roots: readonly number[],
): readonly OwnedProcessIdentity[] {
  const owned = new Set(roots.filter((pid) => Number.isSafeInteger(pid) && pid > 1))
  let changed = true
  while (changed) {
    changed = false
    for (const process of snapshot) {
      if (owned.has(process.pid) || !owned.has(process.ppid)) continue
      owned.add(process.pid)
      changed = true
    }
  }
  return snapshot.filter((process) => owned.has(process.pid))
}

function sameIdentity(left: OwnedProcessIdentity, right: OwnedProcessIdentity) {
  return left.pid === right.pid && left.started === right.started && left.command === right.command
}

function survivors(
  captured: readonly OwnedProcessIdentity[],
  current: readonly OwnedProcessIdentity[],
): readonly OwnedProcessIdentity[] {
  const byPID = new Map(current.map((process) => [process.pid, process]))
  return captured.filter((process) => {
    const candidate = byPID.get(process.pid)
    return candidate !== undefined && sameIdentity(process, candidate)
  })
}

function defaultSignal(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return
    throw error
  }
}

function defaultWait(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

export async function reapCapturedProcessTree(
  captured: readonly OwnedProcessIdentity[],
  hooks: ProcessOwnerHooks = {},
): Promise<OwnedProcessCleanup> {
  const snapshot = hooks.snapshot ?? processSnapshot
  const signal = hooks.signal ?? defaultSignal
  const wait = hooks.wait ?? defaultWait
  if (captured.length === 0) return { survivedClose: [], forceKilled: [], remaining: [] }

  await wait(200)
  const survivedClose = survivors(captured, await snapshot())
  if (survivedClose.length > 0) await hooks.onSurvivors?.(survivedClose)
  for (const process of survivedClose.toReversed()) signal(process.pid, "SIGTERM")
  if (survivedClose.length > 0) await wait(300)
  const forceKilled = survivors(survivedClose, await snapshot())
  for (const process of forceKilled.toReversed()) signal(process.pid, "SIGKILL")
  if (forceKilled.length > 0) await wait(100)
  const remaining = survivors(forceKilled, await snapshot())
  return { survivedClose, forceKilled, remaining }
}

export * as McpProcessOwner from "./mcp-process-owner"
