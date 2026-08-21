// ── Passive Research Coverage ───────────────────────────────────
// Persists three deliberately separate metadata streams: canonical HTTP
//   surface from ZAP, semantic UI activity from agent-browser, and direct
//   egress that ZAP cannot observe.
// → cyberful/src/subsystem/gateway/zap-history-collector.ts — supplies passive HTTP metadata.
// → cyberful/src/subsystem/gateway/server.ts — annotates browser activity and direct egress.
// @docs/user-guide/workflows.md
// @docs/runtimes/browser.md
// @docs/runtimes/zap.md
// ─────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { BrowserProfile, type BrowserProfileId, type TargetBrowserProfileId } from "@/dependency/browser-profile"
import { isRecord } from "@/util/record"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { EngagementPolicy } from "./engagement-policy"
import type { ToolUsageEvent } from "./tool-usage"
import type { ZapHistoryFailureCode } from "./zap-history-collector"

export const BROWSER_ACTION_META_KEY = "cyberful.dev/browser-action"

export type BrowserActionFamily = "navigation" | "ui_interaction" | "ui_input" | "script" | "observation"

export interface BrowserActivity {
  readonly profile: BrowserProfileId
  readonly tabID: string
  readonly actionFamily: BrowserActionFamily
  readonly outcome: "ok" | "error"
  readonly origin?: string
}

export interface HttpSurfaceObservation {
  readonly zapID: string
  readonly origin: string
  readonly pathFamily: string
  readonly method?: string
  readonly status?: number
  readonly hasResponse: boolean
  readonly inScope: boolean
}

export interface ResearchCloseoutAssessment {
  readonly version: 1
  readonly webTarget: boolean
  readonly unusedProfiles: readonly TargetBrowserProfileId[]
  readonly coverageCandidateCount: number
  readonly coverageCandidateSamples: readonly string[]
  readonly collectorDegraded: boolean
}

type DirectEgress = {
  readonly origin: string
  readonly pathFamily: string
  readonly method?: string
  readonly status?: number
  readonly outcome: "ok" | "error"
  readonly route?: string
}

type CoverageRecord =
  | ({ readonly kind: "browser_activity" } & BrowserActivity)
  | ({ readonly kind: "http_surface" } & Omit<HttpSurfaceObservation, "inScope">)
  | ({ readonly kind: "passive_dependency" } & Omit<HttpSurfaceObservation, "inScope">)
  | ({ readonly kind: "direct_egress" } & DirectEgress)
  | {
      readonly kind: "collector_diagnostic"
      readonly state: "ok" | "degraded"
      readonly code: "ZAP_HISTORY_SYNC_FAILED" | "ZAP_HISTORY_SYNC_RECOVERED"
      readonly failureCode?: ZapHistoryFailureCode
      readonly cursor?: number
    }

const MEANINGFUL_BROWSER_ACTIONS = new Set<BrowserActionFamily>([
  "navigation",
  "ui_interaction",
  "ui_input",
  "script",
])
const ACTION_FAMILIES = new Set<BrowserActionFamily>([
  "navigation",
  "ui_interaction",
  "ui_input",
  "script",
  "observation",
])

function safeOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    return url.origin
  } catch {
    return
  }
}

function decode(value: unknown): BrowserActivity | undefined {
  if (!isRecord(value) || !BrowserProfile.isBrowserProfileId(value.profile)) return
  const tabID = typeof value.tab_id === "string" ? value.tab_id : typeof value.page_id === "string" ? value.page_id : undefined
  if (!tabID || !ACTION_FAMILIES.has(value.action_family as BrowserActionFamily)) return
  if (value.outcome !== "ok" && value.outcome !== "error") return
  const origin = safeOrigin(value.origin)
  return {
    profile: value.profile,
    tabID,
    actionFamily: value.action_family as BrowserActionFamily,
    outcome: value.outcome,
    ...(origin ? { origin } : {}),
  }
}

function hydrateRecord(value: unknown, phase: string): CoverageRecord | undefined {
  if (!isRecord(value) || value.version !== 3 || value.phase !== phase || typeof value.kind !== "string") return
  if (value.kind === "browser_activity") {
    const activity = decode({
      profile: value.profile,
      tab_id: value.tabID,
      action_family: value.actionFamily,
      outcome: value.outcome,
      origin: value.origin,
    })
    return activity && activity.profile !== BrowserProfile.SEARCH_BROWSER_PROFILE_ID
      ? { kind: "browser_activity", ...activity }
      : undefined
  }
  if (value.kind === "http_surface" || value.kind === "passive_dependency") {
    const origin = safeOrigin(value.origin)
    if (
      !origin ||
      typeof value.zapID !== "string" ||
      !value.zapID ||
      typeof value.pathFamily !== "string" ||
      !value.pathFamily.startsWith("/") ||
      typeof value.hasResponse !== "boolean"
    )
      return
    const method = typeof value.method === "string" && /^[A-Z]{2,20}$/.test(value.method) ? value.method : undefined
    const status =
      typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599
        ? value.status
        : undefined
    return {
      kind: value.kind,
      zapID: value.zapID.slice(0, 128),
      origin,
      pathFamily: value.pathFamily.slice(0, 180),
      ...(method ? { method } : {}),
      ...(status !== undefined ? { status } : {}),
      hasResponse: value.hasResponse,
    }
  }
  if (value.kind === "direct_egress") {
    if (
      typeof value.origin !== "string" ||
      !value.origin.startsWith("network://") ||
      typeof value.pathFamily !== "string" ||
      !value.pathFamily.startsWith("/") ||
      (value.outcome !== "ok" && value.outcome !== "error")
    )
      return
    return {
      kind: "direct_egress",
      origin: value.origin.slice(0, 280),
      pathFamily: value.pathFamily.slice(0, 180),
      ...(typeof value.method === "string" ? { method: value.method.slice(0, 20) } : {}),
      ...(typeof value.status === "number" ? { status: value.status } : {}),
      outcome: value.outcome,
      ...(typeof value.route === "string" ? { route: value.route.slice(0, 120) } : {}),
    }
  }
  if (
    value.kind === "collector_diagnostic" &&
    (value.state === "ok" || value.state === "degraded") &&
    (value.code === "ZAP_HISTORY_SYNC_FAILED" || value.code === "ZAP_HISTORY_SYNC_RECOVERED")
  )
    return {
      kind: "collector_diagnostic",
      state: value.state,
      code: value.code,
      ...(typeof value.failureCode === "string" ? { failureCode: value.failureCode as ZapHistoryFailureCode } : {}),
      ...(typeof value.cursor === "number" && Number.isInteger(value.cursor) && value.cursor >= 0
        ? { cursor: value.cursor }
        : {}),
    }
}

export function browserActivity(result: CallToolResult): BrowserActivity | undefined {
  return decode(isRecord(result._meta) ? result._meta[BROWSER_ACTION_META_KEY] : undefined)
}

function sorted(values: Iterable<string | number>) {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right)))
}

function routeKey(entry: { readonly origin: string; readonly pathFamily: string }) {
  return `${entry.origin}${entry.pathFamily}`
}

function summaryRouteFamilies(value: unknown): readonly string[] {
  if (!isRecord(value) || (value.version !== 2 && value.version !== 3) || typeof value.phase !== "string") return []
  const candidates = value.version === 3 ? value.http_route_families : value.route_families
  if (!Array.isArray(candidates)) return []
  return candidates.filter((route): route is string => typeof route === "string" && /^https?:\/\//.test(route))
}

export class SurfaceCoverage {
  readonly #phase: string
  readonly #ledger: string
  readonly #summary: string
  readonly #summaryRoot: string
  readonly #records: CoverageRecord[] = []
  readonly #browserScopes = new Map<
    string,
    Pick<BrowserActivity, "profile" | "tabID" | "origin"> & { readonly ownerRunID: string }
  >()
  #collectorDegraded = false
  #queue: Promise<void>

  constructor(workareaRoot: string, phase: string) {
    if (!path.isAbsolute(workareaRoot)) throw new Error("surface coverage requires an absolute workarea root")
    this.#phase = phase
    const operations = path.join(workareaRoot, "raw", "operations")
    this.#ledger = path.join(operations, "surface-coverage.jsonl")
    this.#summaryRoot = path.join(operations, "surface-coverage")
    this.#summary = path.join(this.#summaryRoot, `${phase}.summary.json`)
    this.#queue = this.#hydrate()
  }

  observeBrowser(result: CallToolResult, ownerRunID?: string): Promise<void> {
    const activity = browserActivity(result)
    if (!activity) return Promise.resolve()
    if (ownerRunID)
      this.#browserScopes.set(this.#scopeKey(ownerRunID, activity.profile), {
        ownerRunID,
        profile: activity.profile,
        tabID: activity.tabID,
        ...(activity.origin ? { origin: activity.origin } : {}),
      })
    if (activity.profile === BrowserProfile.SEARCH_BROWSER_PROFILE_ID) return Promise.resolve()
    return this.#append([{ kind: "browser_activity", ...activity }])
  }

  observeDirectEgress(
    result: CallToolResult,
    egress?: Pick<
      ToolUsageEvent,
      "egress_host" | "egress_method" | "egress_http_status" | "egress_path_family" | "egress_route"
    >,
  ): Promise<void> {
    if (!egress?.egress_host || !egress.egress_path_family) return Promise.resolve()
    if (egress.egress_route === "browser/direct-search" || egress.egress_route === "browser/zap" || egress.egress_route === "zap")
      return Promise.resolve()
    return this.#append([{
      kind: "direct_egress",
      origin: `network://${egress.egress_host}`,
      pathFamily: egress.egress_path_family,
      method: egress.egress_method,
      status: egress.egress_http_status,
      route: egress.egress_route,
      outcome: result.isError ? "error" : "ok",
    }])
  }

  observe(
    result: CallToolResult,
    egress?: Pick<
      ToolUsageEvent,
      "egress_host" | "egress_method" | "egress_http_status" | "egress_path_family" | "egress_route"
    >,
    ownerRunID?: string,
  ): Promise<void> {
    return Promise.all([this.observeBrowser(result, ownerRunID), this.observeDirectEgress(result, egress)]).then(() => undefined)
  }

  observeHttpSurface(observations: readonly HttpSurfaceObservation[]): Promise<void> {
    const records: CoverageRecord[] = observations.map((observation) => ({
      kind: observation.inScope ? "http_surface" : "passive_dependency",
      zapID: observation.zapID,
      origin: observation.origin,
      pathFamily: observation.pathFamily,
      method: observation.method,
      status: observation.status,
      hasResponse: observation.hasResponse,
    }))
    return this.#append(records)
  }

  setCollectorState(
    state: "ok" | "degraded",
    diagnostic: { readonly code: ZapHistoryFailureCode; readonly cursor: number } | undefined = undefined,
  ): Promise<void> {
    const pending = this.#queue.then(async () => {
      const degraded = state === "degraded"
      const previous = this.#records.findLast(
        (record): record is Extract<CoverageRecord, { kind: "collector_diagnostic" }> =>
          record.kind === "collector_diagnostic",
      )
      const unchanged =
        this.#collectorDegraded === degraded &&
        (!degraded || (previous?.failureCode === diagnostic?.code && previous?.cursor === diagnostic?.cursor))
      if (unchanged) {
        await this.#publishSummary()
        return
      }
      this.#collectorDegraded = degraded
      await this.#persist([{
        kind: "collector_diagnostic",
        state,
        code: degraded ? "ZAP_HISTORY_SYNC_FAILED" : "ZAP_HISTORY_SYNC_RECOVERED",
        ...(degraded && diagnostic ? { failureCode: diagnostic.code, cursor: diagnostic.cursor } : {}),
      }])
    })
    this.#queue = pending.then(() => undefined, () => undefined)
    return pending
  }

  currentScope(
    ownerRunID: string,
    profile: BrowserProfileId,
  ): (Pick<BrowserActivity, "profile" | "tabID" | "origin"> & { readonly ownerRunID: string }) | undefined {
    return this.#browserScopes.get(this.#scopeKey(ownerRunID, profile))
  }

  close(): Promise<void> {
    return this.#queue
  }

  async handoffError(policy: EngagementPolicy | undefined) {
    await this.#queue
    if (this.#phase !== "recon" || !policy) return
    const missing = this.#unusedProfiles(policy)
    if (missing.length > 0)
      return `surface coverage is incomplete for READY + IN_SCOPE profiles: ${missing.join(", ")}`
  }

  async researchCloseoutAssessment(policy: EngagementPolicy | undefined): Promise<ResearchCloseoutAssessment> {
    await this.#queue
    const currentRoutes = new Set(
      this.#records.flatMap((entry) => entry.kind === "http_surface" ? [routeKey(entry)] : []),
    )
    const previousRoutes = new Set<string>()
    const predecessorPhases = this.#phase === "exploit" ? ["recon"] : this.#phase === "hacker" ? ["recon", "exploit"] : []
    for (const predecessor of predecessorPhases) {
      const content = await readFile(path.join(this.#summaryRoot, `${predecessor}.summary.json`), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return
          throw error
        },
      )
      if (content === undefined) continue
      let summary: unknown
      try {
        summary = JSON.parse(content)
      } catch {
        continue
      }
      for (const route of summaryRouteFamilies(summary)) previousRoutes.add(route)
    }
    const candidates = [...previousRoutes].filter((route) => !currentRoutes.has(route)).toSorted()
    return {
      version: 1,
      webTarget: Boolean(policy && this.#eligibleProfiles(policy).some((profile) => profile.origin !== undefined)),
      unusedProfiles: policy ? this.#unusedProfiles(policy) : [],
      coverageCandidateCount: candidates.length,
      coverageCandidateSamples: candidates.slice(0, 8),
      collectorDegraded: this.#collectorDegraded,
    }
  }

  #scopeKey(ownerRunID: string, profile: BrowserProfileId) {
    return `${ownerRunID}\u0000${profile}`
  }

  #eligibleProfiles(policy: EngagementPolicy) {
    return policy.profiles.filter(
      (profile): profile is EngagementPolicy["profiles"][number] & { readonly profile: TargetBrowserProfileId } =>
        BrowserProfile.isTargetBrowserProfileId(profile.profile) && profile.readiness === "READY" && profile.scope === "IN_SCOPE",
    )
  }

  #unusedProfiles(policy: EngagementPolicy): TargetBrowserProfileId[] {
    return this.#eligibleProfiles(policy).flatMap((profile) => {
      const used = this.#records.some(
        (entry) =>
          entry.kind === "browser_activity" &&
          entry.profile === profile.profile &&
          entry.outcome === "ok" &&
          MEANINGFUL_BROWSER_ACTIONS.has(entry.actionFamily) &&
          profile.origin !== undefined &&
          entry.origin === profile.origin,
      )
      return used ? [] : [profile.profile]
    })
  }

  #append(records: readonly CoverageRecord[]): Promise<void> {
    if (records.length === 0) return Promise.resolve()
    const pending = this.#queue.then(() => this.#persist(records))
    this.#queue = pending.then(() => undefined, () => undefined)
    return pending
  }

  async #persist(records: readonly CoverageRecord[]) {
    this.#records.push(...records)
    await mkdir(this.#summaryRoot, { recursive: true, mode: 0o700 })
    await writeFile(this.#ledger, "", { flag: "a", mode: 0o600 })
    await appendFile(
      this.#ledger,
      records.map((record) => JSON.stringify({ version: 3, time_iso: new Date().toISOString(), phase: this.#phase, ...record })).join("\n") + "\n",
    )
    await this.#publishSummary()
  }

  async #hydrate() {
    const content = await readFile(this.#ledger, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
    if (content === undefined) return
    for (const line of content.split("\n")) {
      if (!line.trim()) continue
      try {
        const record = hydrateRecord(JSON.parse(line), this.#phase)
        if (record) this.#records.push(record)
      } catch {
        // A malformed diagnostic row cannot invalidate otherwise durable coverage.
      }
    }
    const collector = this.#records.findLast(
      (record): record is Extract<CoverageRecord, { kind: "collector_diagnostic" }> =>
        record.kind === "collector_diagnostic",
    )
    this.#collectorDegraded = collector?.state === "degraded"
  }

  async #publishSummary() {
    await mkdir(this.#summaryRoot, { recursive: true, mode: 0o700 })
    const httpSurfaces = this.#reduceSurfaces("http_surface")
    const dependencies = this.#reduceSurfaces("passive_dependency")
    const directSurfaces = this.#reduceDirectSurfaces()
    const browserRecords = this.#records.filter(
      (entry): entry is Extract<CoverageRecord, { kind: "browser_activity" }> => entry.kind === "browser_activity",
    )
    const actionFamilyCounts = Object.fromEntries(
      sorted(browserRecords.map((entry) => entry.actionFamily)).map((family) => [
        family,
        browserRecords.filter((entry) => entry.actionFamily === family).length,
      ]),
    )
    const summary = {
      version: 3,
      phase: this.#phase,
      collector: {
        source: "zap_history",
        degraded: this.#collectorDegraded,
        ...(() => {
          const diagnostic = this.#records.findLast(
            (record): record is Extract<CoverageRecord, { kind: "collector_diagnostic" }> =>
              record.kind === "collector_diagnostic",
          )
          return diagnostic?.state === "degraded"
            ? { failure_code: diagnostic.failureCode ?? "ZAP_HISTORY_TOOL_ERROR", cursor: diagnostic.cursor ?? 0 }
            : {}
        })(),
      },
      origins: sorted(httpSurfaces.map((surface) => surface.origin)),
      route_families: httpSurfaces.map((surface) => `${surface.origin}${surface.path_family}`),
      http_route_families: httpSurfaces.map((surface) => `${surface.origin}${surface.path_family}`),
      methods_observed: sorted(httpSurfaces.flatMap((surface) => surface.methods)),
      http_statuses_observed: sorted(httpSurfaces.flatMap((surface) => surface.http_statuses)),
      http_surface: httpSurfaces,
      passive_dependencies: dependencies,
      direct_egress: directSurfaces,
      ui_action_families: sorted(browserRecords.map((entry) => entry.actionFamily)),
      ui_action_family_counts: actionFamilyCounts,
      profiles: sorted(browserRecords.map((entry) => entry.profile)),
      failed_only: sorted(
        httpSurfaces.flatMap((surface) => surface.responses_present ? [] : [`${surface.origin}${surface.path_family}`]),
      ),
      per_profile: [1, 2, 3, 4, 5].flatMap((profile) => {
        const records = browserRecords.filter((entry) => entry.profile === profile)
        if (records.length === 0) return []
        return [{
          profile,
          origins: sorted(records.flatMap((entry) => entry.origin ? [entry.origin] : [])),
          action_family_counts: Object.fromEntries(
            sorted(records.map((entry) => entry.actionFamily)).map((family) => [
              family,
              records.filter((entry) => entry.actionFamily === family).length,
            ]),
          ),
          meaningful_actions: records.filter((entry) => MEANINGFUL_BROWSER_ACTIONS.has(entry.actionFamily)).length,
          meaningful_origins: sorted(
            records.flatMap((entry) =>
              entry.origin && entry.outcome === "ok" && MEANINGFUL_BROWSER_ACTIONS.has(entry.actionFamily)
                ? [entry.origin]
                : [],
            ),
          ),
          errors: records.filter((entry) => entry.outcome === "error").length,
        }]
      }),
    }
    const temporary = `${this.#summary}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(summary, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    await rename(temporary, this.#summary)
  }

  #reduceSurfaces(kind: "http_surface" | "passive_dependency") {
    const surfaces = new Map<
      string,
      {
        readonly origin: string
        readonly path_family: string
        readonly zap_ids: Set<string>
        readonly methods: Set<string>
        readonly http_statuses: Set<number>
        responses_present: boolean
      }
    >()
    for (const entry of this.#records) {
      if (entry.kind !== kind) continue
      const key = routeKey(entry)
      const surface = surfaces.get(key) ?? {
        origin: entry.origin,
        path_family: entry.pathFamily,
        zap_ids: new Set<string>(),
        methods: new Set<string>(),
        http_statuses: new Set<number>(),
        responses_present: false,
      }
      surface.zap_ids.add(entry.zapID)
      if (entry.method) surface.methods.add(entry.method)
      if (entry.status !== undefined) surface.http_statuses.add(entry.status)
      surface.responses_present ||= entry.hasResponse
      surfaces.set(key, surface)
    }
    return [...surfaces.values()]
      .toSorted((left, right) =>
        routeKey({ origin: left.origin, pathFamily: left.path_family }).localeCompare(
          routeKey({ origin: right.origin, pathFamily: right.path_family }),
        ),
      )
      .map((surface) => ({
        origin: surface.origin,
        path_family: surface.path_family,
        zap_ids: sorted(surface.zap_ids),
        methods: sorted(surface.methods),
        http_statuses: sorted(surface.http_statuses),
        responses_present: surface.responses_present,
      }))
  }

  #reduceDirectSurfaces() {
    const surfaces = new Map<
      string,
      {
        origin: string
        path_family: string
        methods: Set<string>
        http_statuses: Set<number>
        outcomes: Set<string>
        routes: Set<string>
      }
    >()
    for (const entry of this.#records) {
      if (entry.kind !== "direct_egress") continue
      const key = routeKey(entry)
      const surface = surfaces.get(key) ?? {
        origin: entry.origin,
        path_family: entry.pathFamily,
        methods: new Set<string>(),
        http_statuses: new Set<number>(),
        outcomes: new Set<string>(),
        routes: new Set<string>(),
      }
      if (entry.method) surface.methods.add(entry.method)
      if (entry.status !== undefined) surface.http_statuses.add(entry.status)
      surface.outcomes.add(entry.outcome)
      if (entry.route) surface.routes.add(entry.route)
      surfaces.set(key, surface)
    }
    return [...surfaces.values()]
      .toSorted((left, right) =>
        routeKey({ origin: left.origin, pathFamily: left.path_family }).localeCompare(
          routeKey({ origin: right.origin, pathFamily: right.path_family }),
        ),
      )
      .map((surface) => ({
        origin: surface.origin,
        path_family: surface.path_family,
        methods: sorted(surface.methods),
        http_statuses: sorted(surface.http_statuses),
        outcomes: sorted(surface.outcomes),
        routes: sorted(surface.routes),
      }))
  }
}

export * as GatewaySurfaceCoverage from "./surface-coverage"
