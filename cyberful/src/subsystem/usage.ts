// ── Subsystem-Neutral Session Token Accounting ───────────────────
// Aggregates cumulative token snapshots per runtime process and derives bounded
// context-reuse/churn metrics without interpreting subsystem-specific event shapes.
// → cyberful/src/subsystem/subsystem.ts — translates Codex events into these snapshots.
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

export interface ContextChurn {
  readonly uncachedInput: number
  readonly cacheReadRatio: number
  readonly inputAmplification: number
  readonly churnRatio: number
  readonly reasoningShare: number
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

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Number(Math.min(1, Math.max(0, numerator / denominator)).toFixed(4))
}

// ── Churn Comes From Subsystem Counters ────────────────────────
// Input amplification measures how much context was processed per generated
// token. Churn isolates the non-cached share of that input, while cache reuse and
// reasoning share stay separate so a long but efficiently reused phase is not
// mistaken for repeated context reconstruction. Missing counters resolve to zero
// and remain visibly absent from callers that never received a usage snapshot.
// ─────────────────────────────────────────────────────────────────
export function contextChurn(usage: Totals): ContextChurn {
  const uncachedInput = Math.max(0, usage.input - usage.cache.read)
  return {
    uncachedInput,
    cacheReadRatio: ratio(usage.cache.read, usage.input),
    inputAmplification: Number((usage.input / Math.max(1, usage.output)).toFixed(2)),
    churnRatio: ratio(uncachedInput, usage.input),
    reasoningShare: ratio(usage.reasoning, usage.output),
  }
}

export * as SubsystemUsage from "./usage"
