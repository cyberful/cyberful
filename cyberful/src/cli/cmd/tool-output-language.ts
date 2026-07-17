// ── Tool Output Language Detection ───────────────────────────────
// Cleans terminal output, unwraps cyberful-os envelopes, and infers a supported
//   syntax language from paths, commands, metadata, and bounded content clues.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import stripAnsi from "strip-ansi"
import { LANGUAGE_EXTENSIONS } from "@/cli/syntax-language"

export type ToolOutputLanguageHints = {
  command?: string
  filePath?: string
  filetype?: string
  path?: string
  tool?: string
}

export type CyberfulOsToolOutput = {
  metadata: Array<{ key: string; value: string }>
  stdout: string
  stderr?: string
}

const SUPPORTED_FILETYPES = new Set([
  "agda",
  "bash",
  "c",
  "clojure",
  "cpp",
  "css",
  "csharp",
  "diff",
  "elixir",
  "fsharp",
  "go",
  "haskell",
  "hcl",
  "html",
  "java",
  "json",
  "julia",
  "kotlin",
  "lua",
  "make",
  "markdown",
  "nix",
  "ocaml",
  "php",
  "python",
  "r",
  "ruby",
  "rust",
  "scala",
  "swift",
  "toml",
  "typescript",
  "vim",
  "xml",
  "yaml",
])

const PRIORITY = ["html", "json", "diff", "xml", "typescript", "python", "css", "bash", "yaml", "markdown", "toml"]

export function cleanToolOutputText(raw: string) {
  return stripAnsi(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
}

export function detectToolOutputFiletype(raw: string, hints: ToolOutputLanguageHints = {}) {
  const forced = normalizeFiletype(hints.filetype)
  if (forced) return forced

  const text = cleanToolOutputText(raw).trim()
  if (!text) return undefined

  const scores: Record<string, number> = {}
  const add = (filetype: string | undefined, points: number) => {
    if (!filetype) return
    scores[filetype] = (scores[filetype] ?? 0) + points
  }

  const lines = text.split("\n").filter((line) => line.trim())
  const lowerCommand = hints.command?.trim().toLowerCase() ?? ""

  add(filetypeFromPath(hints.filePath), 8)
  add(filetypeFromPath(hints.path), 3)
  readCommandFiletypes(lowerCommand).forEach((filetype) => add(filetype, 7))
  if (/^(?:bun|npm|pnpm|yarn|node|git|curl|wget|cat|sed|awk|rg|grep|find|ls|cd|mkdir|rm|cp|mv)\b/.test(lowerCommand)) {
    add("bash", 4)
  }

  if (/^(?:<!doctype\s+html|<html(?:\s|>))/i.test(text)) add("html", 12)
  if (
    /^<(?:head|body|script|style|meta|link|form|input|div|span|section|article|button)\b/i.test(text) &&
    (text.match(/<\/?[a-z][\w:-]*(?:\s[^>]*)?>/gi)?.length ?? 0) >= 4
  ) {
    add("html", 8)
  }

  if (/^<\?xml\b/i.test(text)) add("xml", 10)
  if (!scores.html && /^<[\w:-]+(?:\s[^>]*)?>[\s\S]*<\/[\w:-]+>$/.test(text)) add("xml", 7)

  if (looksLikeJson(text)) add("json", 12)
  if (/^diff --git /m.test(text) || /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text)) add("diff", 12)
  if (lines.filter((line) => /^[+-](?![+-]{2,3}\b)/.test(line)).length >= 2) add("diff", 6)

  if (/```/.test(text)) add("markdown", 10)
  if (looksLikeMarkdown(lines)) add("markdown", 10)

  if (!/{{[\s\S]*?}}/.test(text)) {
    if (/\{(?:\s*[-\w]+\s*:\s*[^;{}]+;){2,}\s*\}/m.test(text)) add("css", 8)
    if (/^\s*(?:[#.][\w-]+|[a-z][\w-]*(?:\[[^\]]+\])?)\s*\{/im.test(text)) add("css", 6)
  }

  if (/^#!.*\b(?:bash|sh|zsh)\b/m.test(text)) add("bash", 10)
  if (/^(?:bun|npm|pnpm|yarn|node|git|curl|wget|cat|sed|awk|rg|grep|find|ls|cd|mkdir|rm|cp|mv)\b/.test(text)) {
    add("bash", 6)
  }
  if (/^\s*\$\s+\S+/m.test(text)) add("bash", 6)
  if (
    lines.filter((line) => /^\s*(?:if|then|else|fi|for|while|do|done|case|esac|export|source|alias)\b/.test(line))
      .length >= 2
  ) {
    add("bash", 6)
  }

  if (/\b(?:import|export)\s+(?:type\s+)?[\w*{]/.test(text)) add("typescript", 7)
  if (/\b(?:const|let|var|async function|function|class|interface|type)\s+[$A-Z_a-z]/.test(text)) add("typescript", 7)
  if (/=>/.test(text) && /[{};]/.test(text)) add("typescript", 5)

  if (/^\s*(?:from\s+[\w.]+\s+import\s+\w+|import\s+[\w.]+|def\s+\w+\(|class\s+\w+\()/m.test(text)) add("python", 8)
  if (/^\s*if\s+__name__\s*==\s*["']__main__["']\s*:/m.test(text) || /\bprint\(/.test(text)) add("python", 4)

  if (/^\s*package\s+main\b/m.test(text) || /\bfunc\s+\w+\(/.test(text)) add("go", 8)
  if (/\bfn\s+\w+\s*\(/.test(text) || /\blet\s+mut\s+\w+/.test(text)) add("rust", 7)
  if (/^\s*[\w.-]+\s*=\s*(?:"[^"]*"|'[^']*'|\d+|true|false|\[)/m.test(text)) add("toml", 5)
  if (!/^[{[]/.test(text) && !scores.markdown && yamlKeyLines(lines) >= 3) add("yaml", 6)

  return Object.entries(scores)
    .filter((entry) => entry[1] >= 6)
    .sort((left, right) => right[1] - left[1] || priority(left[0]) - priority(right[0]))
    .map((entry) => entry[0])[0]
}

export function parseCyberfulOsToolOutput(raw: string): CyberfulOsToolOutput | undefined {
  const lines = cleanToolOutputText(raw).split("\n")
  const stdout = lines.findIndex((line) => line === "stdout:")
  if (stdout < 0) return undefined

  const metadata = lines
    .slice(0, stdout)
    .filter((line) => line.trim())
    .map((line) => line.match(/^([a-z_]+):\s*(.*)$/))
  if (metadata.some((line) => !line)) return undefined

  const values = metadata.flatMap((line) => (line ? [{ key: line[1], value: line[2] }] : []))
  if (!values.some((line) => line.key === "target") || !values.some((line) => line.key === "exit_code"))
    return undefined

  const stderr = lines.findIndex((line, index) => index > stdout && line === "stderr:")
  const stderrText = stderr < 0 ? "" : sectionText(lines.slice(stderr + 1))
  return {
    metadata: values,
    stdout: sectionText(lines.slice(stdout + 1, stderr < 0 ? undefined : stderr)),
    ...(stderrText ? { stderr: stderrText } : {}),
  }
}

function readCommandFiletypes(command: string) {
  return (
    command
      .match(/\b(?:cat|sed|head|tail|bat|less|more)\b[^|;&\n]*?(?:\.{0,2}\/|~\/)?[\w./-]+\.[A-Za-z0-9][\w.-]*/g)
      ?.flatMap((item) => item.match(/(?:\.{0,2}\/|~\/)?[\w./-]+\.[A-Za-z0-9][\w.-]*/g) ?? [])
      .map((item) => filetypeFromPath(item))
      .filter((item): item is string => Boolean(item)) ?? []
  )
}

function filetypeFromPath(input?: string) {
  if (!input) return undefined
  return normalizeFiletype(
    LANGUAGE_EXTENSIONS[path.extname(input).toLowerCase()] ?? LANGUAGE_EXTENSIONS[path.basename(input).toLowerCase()],
  )
}

function normalizeFiletype(input?: string) {
  if (!input || input === "none") return undefined
  const normalized =
    input === "javascript" ||
    input === "javascriptreact" ||
    input === "typescriptreact" ||
    input === "tsx" ||
    input === "jsx"
      ? "typescript"
      : input === "shellscript" || input === "sh" || input === "zsh"
        ? "bash"
        : input === "terraform" || input === "terraform-vars"
          ? "hcl"
          : input === "makefile"
            ? "make"
            : input
  return SUPPORTED_FILETYPES.has(normalized) ? normalized : undefined
}

function looksLikeJson(text: string) {
  if (!/^\s*[\[{]/.test(text) || !/[\]}]\s*$/.test(text)) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function yamlKeyLines(lines: string[]) {
  return lines.filter((line) => /^\s*[\w.-]+\s*:\s*(?:$|["'\w[{>-])/.test(line) && !/https?:\/\//.test(line)).length
}

function looksLikeMarkdown(lines: string[]) {
  const structural = lines.filter((line) =>
    /^(?:#{1,6}\s+\S.*|>\s+\S.*|[-*+]\s+\S.*|\d+[.)]\s+\S.*|\|.+\|)$/.test(line.trim()),
  )
  return structural.length >= 2 && structural.some((line) => /^#{1,6}\s/.test(line.trim()))
}

function sectionText(lines: string[]) {
  const start = lines.findIndex((line) => line !== "")
  if (start < 0) return ""
  const end = lines.findLastIndex((line) => line !== "")
  return lines.slice(start, end + 1).join("\n")
}

function priority(filetype: string) {
  const index = PRIORITY.indexOf(filetype)
  return index === -1 ? PRIORITY.length : index
}
