// ── Assistant Timestamp Lines ────────────────────────────────────────────
// Appends, replaces, and extracts the canonical timestamp line persisted with assistant text.
// → cyberful/src/session/message-v2.ts — stores the assistant text carrying this line.
// ──────────────────────────────────────────────────────────────────────

const TIME_PREFIX = "Time: "
const TIME_LINE = /(?:^|\n\n)Time: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s*$/
const DISPLAY_TIME_ICON = "\uF43A"

export function formatAssistantTimestamp(timestamp: number) {
  return new Date(timestamp).toISOString()
}

export function assistantTimeLine(timestamp: number | string) {
  return `${TIME_PREFIX}${typeof timestamp === "number" ? formatAssistantTimestamp(timestamp) : timestamp}`
}

export function assistantDisplayTimeLine(timestamp: string) {
  return `${DISPLAY_TIME_ICON} ${timestamp}`
}

export function splitAssistantTimeLine(text: string) {
  const match = text.match(TIME_LINE)
  if (!match) return { text }
  return {
    text: text.slice(0, match.index).replace(/\n+$/, ""),
    timestamp: match[1],
  }
}

export function appendAssistantTimeLine(text: string, timestamp: number | string) {
  const body = splitAssistantTimeLine(text).text
  return [body, assistantTimeLine(timestamp)].filter((part) => part.length > 0).join("\n\n")
}
