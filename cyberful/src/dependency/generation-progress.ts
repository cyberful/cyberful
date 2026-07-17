// ── Generation Progress Formatting ──────────────────────────────
// Normalizes partial token-usage updates into stable status text and exposes
// parsed display segments without inventing usage before a provider reports it.
// → cyberful/src/cli/cmd/tui/component/prompt/index.tsx — renders these progress values in the TUI.
// ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_OUTPUT_TOKENS = 24_000

function safeInt(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

export function formatStatus(outputTokens: number | undefined, maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS) {
  // An absent count is unknown rather than zero; do not fabricate usage before
  // the external stream reports it.
  if (outputTokens === undefined) return "generating..."
  return `generating... ${String(safeInt(outputTokens)).padStart(String(safeInt(maxOutputTokens)).length, "0")}`
}

export function formatStatusWithRate(
  outputTokens: number,
  tokensPerSecond: number,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
) {
  return `${formatStatus(outputTokens, maxOutputTokens)} · ${safeInt(tokensPerSecond)} t/s`
}

export function parseStatus(value: string) {
  const match = value.match(/^generating\.\.\. (0*)(\d+)(?: · \d+ t\/s)?$/)
  if (!match) return
  if (!match[2]) return
  return {
    leadingZeros: match[1] ?? "",
    tokenDigits: match[2],
  }
}

export * as GenerationProgress from "./generation-progress"
