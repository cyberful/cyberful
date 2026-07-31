// ── Subsystem-Neutral Session Token Accounting ───────────────────
// Aggregates cumulative token snapshots per runtime process and derives bounded
// context-reuse/churn metrics without interpreting subsystem-specific event shapes.
// → cyberful/src/subsystem/subsystem.ts — translates AgentRun events into these snapshots.
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

export function canonicalTotal(input: {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}): number {
  return input.input + input.cacheRead + input.cacheWrite + input.output
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
// Provider adapters expose input, cache reads, and cache writes as disjoint
// prompt-token components. Cache writes are new context processing, while cache
// reads are reused context. Amplification uses their complete prompt total;
// churn isolates the uncached input plus newly written cache entries.
// ─────────────────────────────────────────────────────────────────
export function contextChurn(usage: Totals): ContextChurn {
  const uncachedInput = usage.input + usage.cache.write
  const totalPromptInput = uncachedInput + usage.cache.read
  return {
    uncachedInput,
    cacheReadRatio: ratio(usage.cache.read, totalPromptInput),
    inputAmplification: Number((totalPromptInput / Math.max(1, usage.output)).toFixed(2)),
    churnRatio: ratio(uncachedInput, totalPromptInput),
    reasoningShare: ratio(usage.reasoning, usage.output),
  }
}

export * as SubsystemUsage from "./usage"
