// ── Terminal Logo Glyphs ─────────────────────────────────────────
// Defines Cyberful wordmarks and stable foreground and shadow colors shared by
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

export const marks = "_^~,"

const ink = [202, 216, 235] as const

export type LogoRgb = readonly [number, number, number]

export function logoColorAt(_row?: number, _rows?: number): LogoRgb {
  return ink
}

export function logoShadowAt(_row?: number, _rows?: number): LogoRgb {
  const [r, g, b] = logoColorAt()
  return [Math.round(r * 0.16), Math.round(g * 0.12), Math.round(b * 0.22)]
}
