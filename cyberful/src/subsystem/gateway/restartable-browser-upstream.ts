// ── Restartable Browser MCP Generations ─────────────────────────
// A cancelled Playwright operation may force its profile-scoped MCP process to
// exit after the cancellation grace period. The gateway never retries the
// interrupted target action, but it does quarantine and probe that generation
// before the next action. A dead generation is replaced once, in single-flight,
// so concurrent callers cannot create competing owners for the same profile.
// → mcps/browser/browser_mcp.mjs — performs bounded cancellation teardown.
// → cyberful/src/subsystem/gateway/server.ts — owns process creation and tools.
// @docs/runtimes/browser.md
// ────────────────────────────────────────────────────────────────

export interface RestartableBrowserConnection<T> {
  readonly value: T
  readonly close: () => Promise<void>
}

interface RestartableBrowserUpstreamOptions<T> {
  readonly cancellationGraceMs: number
  readonly connect: (onClose: () => void) => Promise<RestartableBrowserConnection<T>>
  readonly probe: (value: T, signal: AbortSignal) => Promise<void>
  readonly probeTimeoutMs: number
}

interface BrowserGeneration<T> extends RestartableBrowserConnection<T> {
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

export class RestartableBrowserUpstream<T> {
  // ── One Active Generation, One Replacement ───────────────────
  // Connection and quarantine state remain private so callers cannot bypass
  // the health gate or create a second profile owner during recovery.
  // Cancellation delays the next probe until the MCP teardown grace expires.
  // Replacement is single-flight and never replays the interrupted operation.
  // ──────────────────────────────────────────────────────────────
  private readonly options: RestartableBrowserUpstreamOptions<T>
  private active?: BrowserGeneration<T>
  private connecting?: Promise<BrowserGeneration<T>>
  private recovering?: Promise<BrowserGeneration<T>>
  private closing = false
  private generation = 0
  private quarantinedUntil = 0

  constructor(options: RestartableBrowserUpstreamOptions<T>) {
    if (
      !Number.isSafeInteger(options.cancellationGraceMs) ||
      options.cancellationGraceMs < 0 ||
      !Number.isSafeInteger(options.probeTimeoutMs) ||
      options.probeTimeoutMs <= 0
    )
      throw new Error("browser cancellation grace and probe timeout must be bounded integers")
    this.options = options
  }

  async start() {
    return (await this.connection()).value
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

  private async connection(signal?: AbortSignal): Promise<BrowserGeneration<T>> {
    if (this.closing) throw new Error("browser upstream is closing")
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

  private openConnection(): Promise<BrowserGeneration<T>> {
    if (this.closing) return Promise.reject(new Error("browser upstream is closing"))
    if (this.connecting) return this.connecting
    const number = ++this.generation
    let generation: BrowserGeneration<T> | undefined
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
                ? "browser upstream transport closed while a generation was starting"
                : "browser upstream closed while a generation was starting",
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

  private async recover(generation: BrowserGeneration<T>) {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort(new DOMException("browser upstream health probe timed out", "TimeoutError"))
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

  private async invalidate(generation: BrowserGeneration<T>) {
    if (generation.closed) return
    generation.closed = true
    if (this.active === generation) this.active = undefined
    await generation.close().catch(() => undefined)
  }
}
