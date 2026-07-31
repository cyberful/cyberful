// ── Passive Surface Coverage ────────────────────────────────────
// Persists redacted browser and egress metadata plus a phase summary without
//   selectors, entered text, cookies, query values, or response bodies.
// → mcps/browser/browser_mcp.mjs — emits the trusted metadata envelope.
// → cyberful/src/subsystem/gateway/egress-observation.ts — supplies redacted network dimensions.
// → cyberful/src/subsystem/gateway/server.ts — records upstream results.
// @docs/user-guide/workflows.md
// ─────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto"
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { isRecord } from "@/util/record"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { ToolUsageEvent } from "./tool-usage"
import type { EngagementPolicy } from "./engagement-policy"

export const BROWSER_ACTION_META_KEY = "cyberful.dev/browser-action"

export interface BrowserAction {
  readonly profile: number
  readonly pageID: string
  readonly origin: string
  readonly pathFamily: string
  readonly action: string
  readonly actionFamily: string
  readonly pageTransition: "none" | "same_origin" | "cross_origin"
  readonly outcome: "ok" | "error"
  readonly status?: number
}

type EgressAction = {
  readonly origin: string
  readonly pathFamily: string
  readonly method?: string
  readonly status?: number
  readonly outcome: "ok" | "error"
  readonly route?: string
}

type CoverageAction =
  | ({ readonly kind: "browser" } & BrowserAction)
  | ({ readonly kind: "egress" } & EgressAction)

function decode(value: unknown): BrowserAction | undefined {
  if (!isRecord(value)) return
  if (!Number.isInteger(value.profile) || (value.profile as number) < 1 || (value.profile as number) > 5) return
  const strings = ["page_id", "origin", "path_family", "action", "action_family", "page_transition", "outcome"] as const
  if (strings.some((field) => typeof value[field] !== "string")) return
  if (!new Set(["none", "same_origin", "cross_origin"]).has(value.page_transition as string)) return
  if (value.outcome !== "ok" && value.outcome !== "error") return
  if (value.status !== null && value.status !== undefined && (!Number.isInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 599)) return
  return {
    profile: value.profile as number,
    pageID: value.page_id as string,
    origin: value.origin as string,
    pathFamily: value.path_family as string,
    action: value.action as string,
    actionFamily: value.action_family as string,
    pageTransition: value.page_transition as BrowserAction["pageTransition"],
    outcome: value.outcome,
    ...(typeof value.status === "number" ? { status: value.status } : {}),
  }
}

export function browserAction(result: CallToolResult): BrowserAction | undefined {
  return decode(isRecord(result._meta) ? result._meta[BROWSER_ACTION_META_KEY] : undefined)
}

function sorted(values: Iterable<string | number>) {
  return [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b)))
}

export class SurfaceCoverage {
  readonly #phase: string
  readonly #ledger: string
  readonly #summary: string
  readonly #records: CoverageAction[] = []
  #queue: Promise<void> = Promise.resolve()

  constructor(workareaRoot: string, phase: string) {
    if (!path.isAbsolute(workareaRoot)) throw new Error("surface coverage requires an absolute workarea root")
    this.#phase = phase
    const root = path.join(workareaRoot, "raw", "operations")
    this.#ledger = path.join(root, "surface-coverage.jsonl")
    this.#summary = path.join(root, "surface-coverage", `${phase}.summary.json`)
  }

  observe(
    result: CallToolResult,
    egress?: Pick<
      ToolUsageEvent,
      "egress_host" | "egress_method" | "egress_http_status" | "egress_path_family" | "egress_route"
    >,
  ): Promise<void> {
    const browser = browserAction(result)
    const actions: CoverageAction[] = [
      ...(browser ? [{ kind: "browser" as const, ...browser }] : []),
      ...(egress?.egress_host && egress.egress_path_family
        ? [{
            kind: "egress" as const,
            origin: `network://${egress.egress_host}`,
            pathFamily: egress.egress_path_family,
            method: egress.egress_method,
            status: egress.egress_http_status,
            route: egress.egress_route,
            outcome: result.isError ? "error" as const : "ok" as const,
          }]
        : []),
    ]
    if (actions.length === 0) return Promise.resolve()
    const pending = this.#queue.then(async () => {
      this.#records.push(...actions)
      await mkdir(path.dirname(this.#summary), { recursive: true, mode: 0o700 })
      await writeFile(this.#ledger, "", { flag: "a", mode: 0o600 })
      await appendFile(
        this.#ledger,
        actions
          .map((action) =>
            JSON.stringify({ version: 2, time_iso: new Date().toISOString(), phase: this.#phase, ...action }),
          )
          .join("\n") + "\n",
      )
      await this.#publishSummary()
    })
    this.#queue = pending.then(() => undefined, () => undefined)
    return pending
  }

  currentScope(profile: number): Pick<BrowserAction, "profile" | "pageID" | "origin"> | undefined {
    const action = this.#records.findLast(
      (entry): entry is Extract<CoverageAction, { kind: "browser" }> =>
        entry.kind === "browser" && entry.profile === profile,
    )
    return action ? { profile: action.profile, pageID: action.pageID, origin: action.origin } : undefined
  }

  close(): Promise<void> {
    return this.#queue
  }

  async handoffError(policy: EngagementPolicy | undefined) {
    await this.#queue
    if (this.#phase !== "recon" || !policy) return
    const missing = policy.profiles.flatMap((profile) => {
      if (profile.readiness !== "READY" || profile.scope !== "IN_SCOPE") return []
      const records = this.#records.filter(
        (entry): entry is Extract<CoverageAction, { kind: "browser" }> =>
          entry.kind === "browser" && entry.profile === profile.profile,
      )
      const reachedOrigin = records.some(
        (entry) => entry.outcome === "ok" && (!profile.origin || entry.origin === profile.origin),
      )
      const meaningfulAction = records.some(
        (entry) =>
          entry.outcome === "ok" &&
          ["navigation", "ui_interaction", "ui_input", "script"].includes(entry.actionFamily),
      )
      return reachedOrigin && meaningfulAction ? [] : [profile.profile]
    })
    if (missing.length > 0)
      return `surface coverage is incomplete for READY + IN_SCOPE profiles: ${missing.join(", ")}`
  }

  // ── One Per-Route Reducer Owns The Summary ─────────────────────
  // One call may carry browser and egress observations for different surfaces,
  // while repeated calls may mix successful and failed outcomes on one route.
  // A single reducer retains those dimensions together and derives every flat
  // compatibility list from the same sets. A route is failed-only only when no
  // successful observation exists, so HTTP denials never become tool failures.
  // ────────────────────────────────────────────────────────────────
  async #publishSummary() {
    const surfaces = new Map<
      string,
      {
        readonly origin: string
        readonly pathFamily: string
        readonly methods: Set<string>
        readonly statuses: Set<number>
        readonly outcomes: Set<"ok" | "error">
        exercised: boolean
      }
    >()
    for (const entry of this.#records) {
      const key = `${entry.origin}${entry.pathFamily}`
      const surface = surfaces.get(key) ?? {
        origin: entry.origin,
        pathFamily: entry.pathFamily,
        methods: new Set<string>(),
        statuses: new Set<number>(),
        outcomes: new Set<"ok" | "error">(),
        exercised: false,
      }
      const method = entry.kind === "egress" ? entry.method : entry.action === "browser_navigate" ? "GET" : undefined
      if (method) surface.methods.add(method)
      if (entry.status !== undefined) surface.statuses.add(entry.status)
      surface.outcomes.add(entry.outcome)
      surface.exercised ||=
        entry.kind === "egress" ||
        ["navigation", "ui_interaction", "ui_input", "script"].includes(entry.actionFamily)
      surfaces.set(key, surface)
    }
    const surfaceDetails = [...surfaces.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([, surface]) => ({
        origin: surface.origin,
        path_family: surface.pathFamily,
        methods: sorted(surface.methods),
        http_statuses: sorted(surface.statuses),
        outcomes: sorted(surface.outcomes),
      }))
    const summary = {
      version: 2,
      phase: this.#phase,
      origins: sorted(surfaceDetails.map((surface) => surface.origin)),
      route_families: [...surfaces.keys()].toSorted(),
      methods_observed: sorted(surfaceDetails.flatMap((surface) => surface.methods)),
      http_statuses_observed: sorted(surfaceDetails.flatMap((surface) => surface.http_statuses)),
      surface_details: surfaceDetails,
      ui_action_families: sorted(
        this.#records.flatMap((entry) => (entry.kind === "browser" ? [entry.actionFamily] : [])),
      ),
      profiles: sorted(this.#records.flatMap((entry) => (entry.kind === "browser" ? [entry.profile] : []))),
      protocols: sorted(surfaceDetails.map((surface) => surface.origin.split(":", 1)[0] ?? "unknown")),
      state_transitions: sorted(
        this.#records.flatMap((entry) => (entry.kind === "browser" ? [entry.pageTransition] : [])),
      ),
      observed_not_exercised: sorted(
        [...surfaces].flatMap(([route, surface]) => surface.exercised ? [] : [route]),
      ),
      failed_only: sorted(
        [...surfaces].flatMap(([route, surface]) => surface.outcomes.has("ok") ? [] : [route]),
      ),
      per_profile: [1, 2, 3, 4, 5].flatMap((profile) => {
        const records = this.#records.filter(
          (entry): entry is Extract<CoverageAction, { kind: "browser" }> =>
            entry.kind === "browser" && entry.profile === profile,
        )
        if (records.length === 0) return []
        return [{
          profile,
          origins: sorted(records.map((entry) => entry.origin)),
          route_families: sorted(records.map((entry) => `${entry.origin}${entry.pathFamily}`)),
          meaningful_actions: records.filter((entry) =>
            ["navigation", "ui_interaction", "ui_input", "script"].includes(entry.actionFamily),
          ).length,
          errors: records.filter((entry) => entry.outcome === "error").length,
        }]
      }),
    }
    const temporary = `${this.#summary}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(summary, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    await rename(temporary, this.#summary)
  }
}

export * as GatewaySurfaceCoverage from "./surface-coverage"
