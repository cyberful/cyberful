// ── Provider-Neutral Session Token Accounting ───────────────────
// Aggregates cumulative generated-token snapshots per runtime process so sessions
// count sequential and concurrent work without interpreting provider event shapes.
// → cyberful/src/subsystem/provider.ts — translates Codex events into these snapshots.
// ─────────────────────────────────────────────────────────────────

export interface Snapshot {
  generatedTokens: number
  inputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  scopeID?: string
}

export interface Totals {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: {
    readonly read: number
    readonly write: number
  }
}

export interface SessionCounter {
  observe(run: object, usage: Snapshot): number
  total(): number
  usage(): Totals
}

export function createSessionCounter(): SessionCounter {
  const runs = new Map<object, Map<string, Totals>>()
  const normalized = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  const usage = (): Totals =>
    [...runs.values()].flatMap((scopes) => [...scopes.values()]).reduce(
      (sum, item) => ({
        input: sum.input + item.input,
        output: sum.output + item.output,
        reasoning: sum.reasoning + item.reasoning,
        cache: { read: sum.cache.read + item.cache.read, write: sum.cache.write + item.cache.write },
      }),
      { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    )
  const total = () => usage().output

  return {
    observe(run, snapshot) {
      const scopes = runs.get(run) ?? new Map<string, Totals>()
      const scope = snapshot.scopeID?.trim() || "root"
      const previous = scopes.get(scope) ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      scopes.set(scope, {
        input: Math.max(previous.input, normalized(snapshot.inputTokens)),
        output: Math.max(previous.output, normalized(snapshot.generatedTokens)),
        reasoning: Math.max(previous.reasoning, normalized(snapshot.reasoningTokens)),
        cache: {
          read: Math.max(previous.cache.read, normalized(snapshot.cacheReadTokens)),
          write: Math.max(previous.cache.write, normalized(snapshot.cacheWriteTokens)),
        },
      })
      runs.set(run, scopes)
      return total()
    },
    total,
    usage,
  }
}

export * as SubsystemUsage from "./usage"
