// ── Terminal Logo Glyphs ─────────────────────────────────────────
// Defines Cyberful wordmarks and the stable foreground color shared by
//   plain terminal output and interactive splash rendering.
// ─────────────────────────────────────────────────────────────────

const wordmark = ["", "", "Cyberful"]

const logoSplit = 28

export const logo = {
  full: wordmark,
  left: wordmark.map((line) => line.slice(0, logoSplit)),
  right: wordmark.map((line) => line.slice(logoSplit)),
}

export const go = {
  full: [" ██████╗███████╗", "██╔════╝██╔════╝", "██║     █████╗  ", "╚██████╗██╔══╝  ", " ╚═════╝██║     "],
  left: [" ██████╗", "██╔════╝", "██║     ", "╚██████╗", " ╚═════╝"],
  right: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "██║     "],
}

const ink = [202, 216, 235] as const

export type LogoRgb = readonly [number, number, number]

export function logoColorAt(_row?: number, _rows?: number): LogoRgb {
  return ink
}
