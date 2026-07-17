// ── Markdown Typography Normalization ────────────────────────────
// Folds visually confusable punctuation to reproducible ASCII for exact-match
// edits while preserving meaningful Unicode and every non-Markdown artifact.
// → cyberful/src/subsystem/sanitize.ts — applies this boundary to Markdown writes.
// → cyberful/src/tool/security-report-pdf.ts — consumes normalized Markdown deliverables.
// ─────────────────────────────────────────────────────────────────

// ── Lossy Folding Is Deliberately Narrow ─────────────────────────
// Models may alternate between typographic punctuation and visually equivalent
// ASCII, causing later exact-match edits to miss the original bytes. Only those
// confusable characters are folded. Emoji, symbols, superscripts, and other
// distinctive Unicode remain untouched, and callers gate normalization to
// Markdown so payloads and proof-of-concept files retain every load-bearing byte.
// ─────────────────────────────────────────────────────────────────

// 1:1 code point replacements (a folded char is never longer than one ASCII char here).
const FOLD: Record<string, string> = {
  " ": " ", // no-break space
  " ": " ", // en space
  " ": " ", // em space
  " ": " ", // three-per-em space
  " ": " ", // four-per-em space
  " ": " ", // six-per-em space
  " ": " ", // figure space
  " ": " ", // punctuation space
  " ": " ", // thin space
  " ": " ", // hair space
  " ": " ", // narrow no-break space
  "‐": "-", // hyphen
  "‑": "-", // non-breaking hyphen
  "‒": "-", // figure dash
  "–": "-", // en dash
  "—": "-", // em dash
  "―": "-", // horizontal bar
  "−": "-", // minus sign
  "‘": "'", // left single quote
  "’": "'", // right single quote
  "‛": "'", // single high-reversed-9 quote
  "′": "'", // prime
  "“": '"', // left double quote
  "”": '"', // right double quote
  "″": '"', // double prime
}

// Multi-character expansions applied after the 1:1 fold.
const EXPAND: Array<[string, string]> = [
  ["…", "..."], // horizontal ellipsis
  ["↔", "<->"], // left-right arrow (before the single arrows)
  ["→", "->"], // rightwards arrow
  ["←", "<-"], // leftwards arrow
]

export function deTypography(text: string): string {
  let out = ""
  for (const ch of text) out += FOLD[ch] ?? ch
  for (const [from, to] of EXPAND) out = out.replaceAll(from, to)
  return out
}

export function isMarkdownPath(filePath: string): boolean {
  return /\.(md|markdown)$/i.test(filePath)
}
