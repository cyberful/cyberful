// ── Shared Browser Profile Hub ──────────────────────────────────────
// Owns one lazy Chromium hub per profile and one lazy, restartable controller
// per AgentRun. Controller failures and owner cleanup never close sibling
// controllers; a profile close interrupts every controller before the hub exits.
// → cyberful/src/subsystem/gateway/server.ts — provides MCP process factories.
// → mcps/browser/browser_mcp.mjs — implements hub and controller process modes.
// @docs/concepts/execution-model.md
// ────────────────────────────────────────────────────────────────────

import { ManagedMcpUpstream, type ManagedMcpUpstreamStatus } from "./restartable-browser-upstream"

export interface BrowserHubConnection {
  readonly endpoint: string
  readonly attestation: string
  readonly alive: () => Promise<boolean>
  readonly close: () => Promise<void>
}

export interface BrowserControllerConnection<T> {
  readonly value: T
  readonly close: () => Promise<void>
}

interface BrowserProfileHubOptions<T> {
  readonly label: string
  readonly cancellationGraceMs: number
  readonly connectHub: () => Promise<BrowserHubConnection>
  readonly connectController: (
    hub: BrowserHubConnection,
    onClose: () => void,
  ) => Promise<BrowserControllerConnection<T>>
  readonly probeController: (controller: T, signal: AbortSignal) => Promise<void>
  readonly probeTimeoutMs: number
}

export class BrowserProfileHub<T> {
  private readonly options: BrowserProfileHubOptions<T>
  private readonly controllers = new Map<string, ManagedMcpUpstream<T>>()
  private closingProfile?: Promise<void>
  private generation = 0
  private hub?: BrowserHubConnection
  private hubOpening?: Promise<BrowserHubConnection>
  private terminal = false

  constructor(options: BrowserProfileHubOptions<T>) {
    this.options = options
  }

  status(): ManagedMcpUpstreamStatus {
    const controllers = [...this.controllers.values()].map((controller) => controller.status())
    return {
      label: this.options.label,
      state: this.terminal || this.closingProfile
        ? "closing"
        : this.hubOpening
          ? "connecting"
          : this.hub
            ? "ready"
            : "disconnected",
      generation: this.generation,
      quarantined: controllers.some((controller) => controller.quarantined),
    }
  }

  async health(signal?: AbortSignal): Promise<ManagedMcpUpstreamStatus> {
    await this.profileReady()
    const hub = await this.ensureHub()
    signal?.throwIfAborted()
    if (!hub.endpoint) throw new Error(`${this.options.label} hub has no CDP endpoint`)
    return this.status()
  }

  async call<R>(
    runID: string,
    operation: (controller: T) => Promise<R>,
    signal?: AbortSignal,
  ): Promise<R> {
    await this.profileReady()
    signal?.throwIfAborted()
    const controller = this.controller(runID)
    return controller.call(operation, signal)
  }

  async releaseOwner(runID: string): Promise<void> {
    const controller = this.controllers.get(runID)
    if (!controller) return
    this.controllers.delete(runID)
    await controller.close()
  }

  closeProfile(): Promise<void> {
    if (this.closingProfile) return this.closingProfile
    const operation = this.closeProfileResources().finally(() => {
      if (this.closingProfile === operation) this.closingProfile = undefined
    })
    this.closingProfile = operation
    return operation
  }

  async close(): Promise<void> {
    this.terminal = true
    await this.closeProfile()
  }

  private controller(runID: string): ManagedMcpUpstream<T> {
    if (this.terminal) throw new Error(`${this.options.label} is closing`)
    const existing = this.controllers.get(runID)
    if (existing) return existing
    const controller = new ManagedMcpUpstream<T>({
      label: `${this.options.label}/${runID}`,
      cancellationGraceMs: this.options.cancellationGraceMs,
      connect: async (onClose) => this.options.connectController(await this.ensureHub(), onClose),
      probe: this.options.probeController,
      probeTimeoutMs: this.options.probeTimeoutMs,
    })
    this.controllers.set(runID, controller)
    return controller
  }

  private async ensureHub(): Promise<BrowserHubConnection> {
    if (this.terminal) throw new Error(`${this.options.label} is closing`)
    if (this.hub) {
      const current = this.hub
      if (await current.alive()) return current
      if (this.hub === current) this.hub = undefined
      await current.close().catch(() => undefined)
    }
    if (this.hubOpening) return this.hubOpening
    const generation = ++this.generation
    const opening = this.options
      .connectHub()
      .then(async (hub) => {
        if (this.terminal || generation !== this.generation) {
          await hub.close().catch(() => undefined)
          throw new Error(`${this.options.label} hub was superseded while starting`)
        }
        this.hub = hub
        return hub
      })
      .finally(() => {
        if (this.hubOpening === opening) this.hubOpening = undefined
      })
    this.hubOpening = opening
    return opening
  }

  private async closeProfileResources(): Promise<void> {
    this.generation += 1
    const controllers = [...this.controllers.values()]
    this.controllers.clear()
    const opening = this.hubOpening
    this.hubOpening = undefined
    const hub = this.hub
    this.hub = undefined

    const controllerResults = await Promise.allSettled(controllers.map((controller) => controller.close()))
    await opening?.catch(() => undefined)
    const hubResult = hub ? await Promise.resolve(hub.close()).then(() => undefined, (error) => error) : undefined
    const failures = controllerResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    )
    if (hubResult !== undefined) failures.push(hubResult)
    if (failures.length > 0) throw new AggregateError(failures, `${this.options.label} profile close failed`)
  }

  private async profileReady(): Promise<void> {
    if (this.closingProfile) await this.closingProfile
    if (this.terminal) throw new Error(`${this.options.label} is closing`)
  }
}
