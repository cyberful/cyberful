// ── Managed MCP Generations ─────────────────────────────────────
// A cancelled or disconnected stateful MCP process may need replacement. The
// gateway never retries the interrupted action, but it probes before the next
// action and opens one single-flight generation when the transport is dead.
// → mcps/browser/browser_mcp.mjs — performs bounded cancellation teardown.
// → cyberful/src/subsystem/gateway/server.ts — owns process creation and tools.
// @docs/runtimes/browser.md
// ────────────────────────────────────────────────────────────────

export interface RestartableBrowserConnection<T> {
  readonly value: T
  readonly close: () => Promise<void>
}

interface ManagedMcpUpstreamOptions<T> {
  readonly label?: string
  readonly cancellationGraceMs: number
  readonly connect: (onClose: () => void) => Promise<RestartableBrowserConnection<T>>
  readonly probe: (value: T, signal: AbortSignal) => Promise<void>
  readonly probeTimeoutMs: number
}

interface ManagedGeneration<T> extends RestartableBrowserConnection<T> {
  readonly number: number
  closed: boolean
}

function abortError(signal: AbortSignal) {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException(signal.reason ? String(signal.reason) : "browser request cancelled", "AbortError")
}

function wait(delayMs: number, signal?: AbortSignal) {
  if (delayMs <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(abortError(signal))
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, delayMs)
    const abort = () => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
      reject(signal ? abortError(signal) : new DOMException("browser request cancelled", "AbortError"))
    }
    function done() {
      signal?.removeEventListener("abort", abort)
      resolve()
    }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

function waitForResult<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal))
    signal.addEventListener("abort", abort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
  })
}

export interface ManagedMcpUpstreamStatus {
  readonly label: string
  readonly state: "disconnected" | "connecting" | "ready" | "recovering" | "closing"
  readonly generation: number
  readonly quarantined: boolean
}

export class ManagedMcpUpstream<T> {
  // ── One Active Generation, One Replacement ───────────────────
  // Connection and quarantine state remain private so callers cannot bypass
  // the health gate or create a second profile owner during recovery.
  // Cancellation delays the next probe until the MCP teardown grace expires.
  // Replacement is single-flight and never replays the interrupted operation.
  // ──────────────────────────────────────────────────────────────
  private readonly options: ManagedMcpUpstreamOptions<T>
  private active?: ManagedGeneration<T>
  private connecting?: Promise<ManagedGeneration<T>>
  private recovering?: Promise<ManagedGeneration<T>>
  private closing = false
  private generation = 0
  private quarantinedUntil = 0

  constructor(options: ManagedMcpUpstreamOptions<T>) {
    if (
      !Number.isSafeInteger(options.cancellationGraceMs) ||
      options.cancellationGraceMs < 0 ||
      !Number.isSafeInteger(options.probeTimeoutMs) ||
      options.probeTimeoutMs <= 0
    )
      throw new Error("managed MCP cancellation grace and probe timeout must be bounded integers")
    this.options = options
  }

  async start() {
    return (await this.connection()).value
  }

  status(): ManagedMcpUpstreamStatus {
    return {
      label: this.options.label ?? "mcp",
      state: this.closing
        ? "closing"
        : this.recovering
          ? "recovering"
          : this.connecting
            ? "connecting"
            : this.active && !this.active.closed
              ? "ready"
              : "disconnected",
      generation: this.generation,
      quarantined: this.quarantinedUntil > Date.now(),
    }
  }

  async health(signal?: AbortSignal): Promise<ManagedMcpUpstreamStatus> {
    const generation = await this.connection(signal)
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(new DOMException("managed MCP health probe timed out", "TimeoutError")),
      this.options.probeTimeoutMs,
    )
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    try {
      await waitForResult(this.options.probe(generation.value, combined), combined)
    } catch (error) {
      await this.invalidate(generation)
      if (signal?.aborted || this.closing) throw error
      const replacement = await this.connection(signal)
      await waitForResult(this.options.probe(replacement.value, combined), combined)
    } finally {
      clearTimeout(timeout)
    }
    return this.status()
  }

  async call<R>(operation: (value: T) => Promise<R>, signal?: AbortSignal): Promise<R> {
    const generation = await this.connection(signal)
    try {
      return await operation(generation.value)
    } catch (error) {
      if (signal?.aborted) {
        this.quarantinedUntil = Math.max(
          this.quarantinedUntil,
          Date.now() + this.options.cancellationGraceMs,
        )
      } else {
        await this.invalidate(generation)
      }
      throw error
    }
  }

  async close() {
    if (this.closing) return
    this.closing = true
    const connecting = this.connecting
    if (connecting) await connecting.catch(() => undefined)
    const recovering = this.recovering
    if (recovering) await recovering.catch(() => undefined)
    const active = this.active
    this.active = undefined
    if (active && !active.closed) {
      active.closed = true
      await active.close()
    }
  }

  private async connection(signal?: AbortSignal): Promise<ManagedGeneration<T>> {
    if (this.closing) throw new Error("managed MCP upstream is closing")
    signal?.throwIfAborted()
    const quarantineMs = this.quarantinedUntil - Date.now()
    if (quarantineMs > 0) await wait(quarantineMs, signal)

    if (this.recovering) return waitForResult(this.recovering, signal)
    const active = this.active
    if (active && !active.closed) {
      if (this.quarantinedUntil > 0) {
        this.quarantinedUntil = 0
        const recovering = this.recover(active).finally(() => {
          if (this.recovering === recovering) this.recovering = undefined
        })
        this.recovering = recovering
        return waitForResult(recovering, signal)
      }
      if (!active.closed) return active
    }

    return waitForResult(this.openConnection(), signal)
  }

  private openConnection(): Promise<ManagedGeneration<T>> {
    if (this.closing) return Promise.reject(new Error("managed MCP upstream is closing"))
    if (this.connecting) return this.connecting
    const number = ++this.generation
    let generation: ManagedGeneration<T> | undefined
    let closedBeforeReady = false
    const connecting = this.options
      .connect(() => {
        if (!generation) {
          closedBeforeReady = true
          return
        }
        generation.closed = true
        if (this.active === generation) this.active = undefined
      })
      .then((connection) => {
        generation = { ...connection, number, closed: closedBeforeReady }
        if (this.closing || closedBeforeReady) {
          generation.closed = true
          return generation.close().then(() => {
            throw new Error(
              closedBeforeReady
                ? "managed MCP upstream transport closed while a generation was starting"
                : "managed MCP upstream closed while a generation was starting",
            )
          })
        }
        this.active = generation
        return generation
      })
      .finally(() => {
        if (this.connecting === connecting) this.connecting = undefined
      })
    this.connecting = connecting
    return connecting
  }

  private async recover(generation: ManagedGeneration<T>) {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort(new DOMException("managed MCP upstream health probe timed out", "TimeoutError"))
    }, this.options.probeTimeoutMs)
    try {
      await waitForResult(this.options.probe(generation.value, controller.signal), controller.signal)
    } catch {
      await this.invalidate(generation)
    } finally {
      clearTimeout(timeout)
    }
    if (!generation.closed) return generation
    return this.openConnection()
  }

  private async invalidate(generation: ManagedGeneration<T>) {
    if (generation.closed) return
    generation.closed = true
    if (this.active === generation) this.active = undefined
    await generation.close().catch(() => undefined)
  }
}

export { ManagedMcpUpstream as RestartableBrowserUpstream }
