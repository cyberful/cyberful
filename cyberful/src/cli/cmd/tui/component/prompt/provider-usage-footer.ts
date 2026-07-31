// ── Compact Provider Usage Footer ────────────────────────────────
// Formats cumulative root/subagent usage without deriving totals or adding
// reasoning a second time. Rendering and width policy remain in the prompt.
// ─────────────────────────────────────────────────────────────────

import type { SessionProviderUsageView } from "@/server/client"

export function compactTokenCount(value: number, locale = "it-IT"): string {
  const normalized = Number.isFinite(value) ? Math.max(0, value) : 0
  const scale =
    normalized >= 1_000_000_000
      ? { divisor: 1_000_000_000, suffix: "B" }
      : normalized >= 1_000_000
        ? { divisor: 1_000_000, suffix: "M" }
        : normalized >= 1_000
          ? { divisor: 1_000, suffix: "K" }
          : { divisor: 1, suffix: "" }
  return `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(normalized / scale.divisor)}${scale.suffix}`
}

export function providerUsageFooter(
  view: SessionProviderUsageView | undefined,
  locale = "it-IT",
) {
  if (!view) return
  const numeric = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0
  const root = {
    input: compactTokenCount(numeric(view.root.input), locale),
    cached: compactTokenCount(numeric(view.root.cacheRead), locale),
    generated: compactTokenCount(numeric(view.root.generated), locale),
  }
  const subagents = {
    input: compactTokenCount(numeric(view.subagents.input), locale),
    cached: compactTokenCount(numeric(view.subagents.cacheRead), locale),
    generated: compactTokenCount(numeric(view.subagents.generated), locale),
  }
  const text =
    `R> i:${root.input} c:${root.cached} g:${root.generated} | ` +
    `S> i:${subagents.input} c:${subagents.cached} g:${subagents.generated}`
  return { root, subagents, text }
}
