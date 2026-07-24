// ── Passive Browser Surface Coverage ────────────────────────────
// Persists redacted browser action metadata and a phase summary without
//   selectors, entered text, cookies, query values, or response bodies.
// → mcps/browser/browser_mcp.mjs — emits the trusted metadata envelope.
// → cyberful/src/subsystem/gateway/server.ts — records upstream results.
// @docs/user-guide/workflows.md
// ─────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto"
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { isRecord } from "@/util/record"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

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
  readonly #records: BrowserAction[] = []
  #queue: Promise<void> = Promise.resolve()

  constructor(workareaRoot: string, phase: string) {
    if (!path.isAbsolute(workareaRoot)) throw new Error("surface coverage requires an absolute workarea root")
    this.#phase = phase
    const root = path.join(workareaRoot, "raw", "operations")
    this.#ledger = path.join(root, "surface-coverage.jsonl")
    this.#summary = path.join(root, "surface-coverage", `${phase}.summary.json`)
  }

  observe(result: CallToolResult): Promise<void> {
    const action = browserAction(result)
    if (!action) return Promise.resolve()
    const pending = this.#queue.then(async () => {
      this.#records.push(action)
      await mkdir(path.dirname(this.#summary), { recursive: true, mode: 0o700 })
      await writeFile(this.#ledger, "", { flag: "a", mode: 0o600 })
      await appendFile(this.#ledger, `${JSON.stringify({ version: 1, time_iso: new Date().toISOString(), phase: this.#phase, ...action })}\n`)
      await this.#publishSummary()
    })
    this.#queue = pending.then(() => undefined, () => undefined)
    return pending
  }

  currentScope(profile: number): Pick<BrowserAction, "profile" | "pageID" | "origin"> | undefined {
    const action = this.#records.findLast((entry) => entry.profile === profile)
    return action ? { profile: action.profile, pageID: action.pageID, origin: action.origin } : undefined
  }

  close(): Promise<void> {
    return this.#queue
  }

  async #publishSummary() {
    const exercised = new Set(
      this.#records
        .filter((entry) => ["navigation", "ui_interaction", "ui_input", "script"].includes(entry.actionFamily))
        .map((entry) => `${entry.origin}${entry.pathFamily}`),
    )
    const observed = new Set(this.#records.map((entry) => `${entry.origin}${entry.pathFamily}`))
    const summary = {
      version: 1,
      phase: this.#phase,
      origins: sorted(this.#records.map((entry) => entry.origin)),
      route_families: sorted(observed),
      methods_observed: sorted(this.#records.filter((entry) => entry.action === "browser_navigate").map(() => "GET")),
      ui_action_families: sorted(this.#records.map((entry) => entry.actionFamily)),
      profiles: sorted(this.#records.map((entry) => entry.profile)),
      protocols: sorted(this.#records.map((entry) => entry.origin.split(":", 1)[0] ?? "unknown")),
      state_transitions: sorted(this.#records.map((entry) => entry.pageTransition)),
      observed_not_exercised: sorted([...observed].filter((route) => !exercised.has(route))),
      blocked_or_failed: sorted(
        this.#records
          .filter((entry) => entry.outcome === "error" || entry.status === 401 || entry.status === 403)
          .map((entry) => `${entry.origin}${entry.pathFamily}`),
      ),
    }
    const temporary = `${this.#summary}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(summary, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    await rename(temporary, this.#summary)
  }
}

export * as GatewaySurfaceCoverage from "./surface-coverage"
