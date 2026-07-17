// ── Human-Readable Value Formatting ──────────────────────────────
// Formats timestamps, counts, durations, truncation, and plurals for compact TUI
// and report presentation without changing the underlying domain values.
// → cyberful/src/cli/cmd/tui — renders these values in user-facing surfaces.
// ─────────────────────────────────────────────────────────────────

export function titlecase(str: string) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function time(input: number): string {
  const date = new Date(input)
  return date.toLocaleTimeString(undefined, { timeStyle: "short" })
}

export function datetime(input: number): string {
  const date = new Date(input)
  const localTime = time(input)
  const localDate = date.toLocaleDateString()
  return `${localTime} · ${localDate}`
}

export function todayTimeOrDateTime(input: number): string {
  const date = new Date(input)
  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()

  if (isToday) return time(input)
  return datetime(input)
}

export function number(num: number): string {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M"
  if (num >= 1_000) return (num / 1_000).toFixed(1) + "K"
  return num.toString()
}

export function duration(input: number) {
  if (input < 1000) {
    return `${input}ms`
  }
  if (input < 60_000) {
    return `${(input / 1000).toFixed(1)}s`
  }
  if (input < 3_600_000) {
    const minutes = Math.floor(input / 60_000)
    const seconds = Math.floor((input % 60_000) / 1_000)
    return `${minutes}m ${seconds}s`
  }
  if (input < 86_400_000) {
    const hours = Math.floor(input / 3_600_000)
    const minutes = Math.floor((input % 3_600_000) / 60_000)
    return `${hours}h ${minutes}m`
  }
  const days = Math.floor(input / 86_400_000)
  const hours = Math.floor((input % 86_400_000) / 3_600_000)
  return `${days}d ${hours}h`
}

export function clockDuration(input: number) {
  const total = Math.max(0, Math.floor(input / 1000))
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map((item) => item.toString().padStart(2, "0"))
    .join(":")
}

export function truncate(str: string, len: number): string {
  if (str.length <= len) return str
  return str.slice(0, len - 1) + "…"
}

export function truncateMiddle(str: string, maxLength: number = 35): string {
  if (str.length <= maxLength) return str

  const ellipsis = "…"
  const keepStart = Math.ceil((maxLength - ellipsis.length) / 2)
  const keepEnd = Math.floor((maxLength - ellipsis.length) / 2)

  return str.slice(0, keepStart) + ellipsis + str.slice(-keepEnd)
}

export * as Locale from "./locale"
