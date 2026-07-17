// ── Application Security PDF Reports ────────────────────────────
// Converts a workflow-selected Markdown artifact into Cyberful's branded PDF
//   deliverable while keeping all source and output paths inside the workarea.
// → cyberful/src/session/prompt.ts — invokes the compatibility wrapper at the terminal boundary.
// @docs/user-guide/sessions-and-reports.md
// ─────────────────────────────────────────────────────────────────

import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises"
import path from "node:path"
import PDFDocument from "pdfkit"
import { marked, type Tokens } from "marked"
import { all, createLowlight } from "lowlight"

// ── Bundled Fonts Make Rendering Reproducible ───────────────────
// Bun resolves these assets from source and from the compiled application bundle.
// PDFKit embeds every face, avoiding network access and host font discovery.
// EB Garamond renders the wordmark and headings; Ubuntu Mono renders code.
// The resulting report therefore keeps the same typography on every host.
// ─────────────────────────────────────────────────────────────────
import ebGaramondPath from "./assets/fonts/EBGaramond.ttf" with { type: "file" }
import ebGaramondBoldPath from "./assets/fonts/EBGaramond-Bold.ttf" with { type: "file" }
import ubuntuMonoPath from "./assets/fonts/UbuntuMono-Regular.ttf" with { type: "file" }

const lowlight = createLowlight(all)
type HighlightRoot = ReturnType<typeof lowlight.highlight>
type HighlightNode = HighlightRoot["children"][number]

type Block =
  | { type: "heading"; depth: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "blockquote"; text: string }
  | { type: "code"; text: string; lang?: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "hr" }

export type ReportMeta = {
  title?: string
  subtitle?: string
  target?: string
  reportVersion?: string
  engagementWindow?: string
  subject?: string
  keywords?: string[]
  dateLabel?: string
}

export type MarkdownReportPdfOptions = {
  workareaCwd: string
  sourcePath: string
  outputPath: string
  resolveVars?: (markdown: string) => string
  meta?: ReportMeta
}

const page = {
  margin: 54,
  footer: 32,
  width: 595.28,
  height: 841.89,
}
const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024
const MAX_PDF_BYTES = 64 * 1024 * 1024

const colors = {
  ink: "#141414",
  heading: "#050505",
  muted: "#5b5b53",
  faint: "#e6e2d8",
  panel: "#f5f5f2",
  canvas: "#efebe3",
  accent: "#02a7e4",
}

const spectrum = ["#76b82a", "#ffd21a", "#ff8a00", "#ef2426", "#b32aa5", "#02a7e4"]

const severityColors: Record<string, { bg: string; fg: string }> = {
  critical: { bg: "#ef2426", fg: "#ffffff" },
  high: { bg: "#ff8a00", fg: "#ffffff" },
  medium: { bg: "#ffd21a", fg: "#1a1a1a" },
  low: { bg: "#76b82a", fg: "#ffffff" },
  informational: { bg: "#02a7e4", fg: "#ffffff" },
}

const FONT = {
  brand: "CyberfulBrand",
  heading: "CyberfulHeading",
  headingBold: "CyberfulHeadingBold",
  body: "Helvetica",
  bodyBold: "Helvetica-Bold",
  italic: "Helvetica-Oblique",
  mono: "CyberfulMono",
}

const LINE_GAP = 2
const TOC_PER_PAGE = 28

const codeBg = "#0b0c0e"
const codeColors: Record<string, string> = {
  default: "#e6e3db",
  "hljs-comment": "#7c8590",
  "hljs-quote": "#7c8590",
  "hljs-meta": "#7c8590",
  "hljs-keyword": "#c792ea",
  "hljs-selector-tag": "#c792ea",
  "hljs-literal": "#c792ea",
  "hljs-section": "#02a7e4",
  "hljs-built_in": "#02a7e4",
  "hljs-type": "#02a7e4",
  "hljs-title": "#02a7e4",
  "hljs-function": "#02a7e4",
  "hljs-link": "#02a7e4",
  "hljs-string": "#76b82a",
  "hljs-regexp": "#76b82a",
  "hljs-addition": "#76b82a",
  "hljs-number": "#ff8a00",
  "hljs-symbol": "#ff8a00",
  "hljs-bullet": "#ff8a00",
  "hljs-variable": "#ff8a00",
  "hljs-template-variable": "#ff8a00",
  "hljs-attr": "#ffd21a",
  "hljs-attribute": "#ffd21a",
  "hljs-property": "#ffd21a",
  "hljs-selector-id": "#ffd21a",
  "hljs-selector-class": "#ffd21a",
  "hljs-name": "#ef2426",
  "hljs-deletion": "#ef2426",
  "hljs-punctuation": "#9aa0a6",
  "hljs-operator": "#9aa0a6",
}

// ── Workflow Configuration Selects The Report Artifact ──────────
// The caller's workflow boundary owns the relative Markdown source, PDF destination,
// and document metadata; the renderer does not infer a workflow from filenames. Paths
// are normalized at this boundary and cannot escape the engagement workarea.
// Variable resolution remains an injected pure transform so this module never
// gains access to the session store, credentials, or another host capability.
// The source is rewritten only after a successful PDF write, preserving the
// existing guarantee that template cleanup cannot destroy the deliverable.
//
// ─────────────────────────────────────────────────────────────────
export async function renderMarkdownReportToPdf(options: MarkdownReportPdfOptions): Promise<string | undefined> {
  const sourcePath = resolveReportPath(options.workareaCwd, options.sourcePath, "sourcePath", ".md")
  const pdfPath = resolveReportPath(options.workareaCwd, options.outputPath, "outputPath", ".pdf")
  const file = Bun.file(sourcePath)
  if (!(await file.exists())) return undefined
  await requireContainedSource(options.workareaCwd, sourcePath)
  if (file.size > MAX_MARKDOWN_BYTES) throw new Error(`Markdown report exceeds ${MAX_MARKDOWN_BYTES} bytes`)
  const raw = (await file.text()).trimEnd() + "\n"
  const markdown = options.resolveVars ? options.resolveVars(raw) : raw
  if (!markdown.trim()) return undefined
  if (Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES) {
    throw new Error(`Resolved Markdown report exceeds ${MAX_MARKDOWN_BYTES} bytes`)
  }
  await mkdir(path.dirname(pdfPath), { recursive: true })
  await requireContainedOutput(options.workareaCwd, pdfPath)
  const title = options.meta?.title ?? titleFromMarkdown(markdown)
  const dateLabel = options.meta?.dateLabel ?? formatDate(new Date())
  const temporaryPdf = `${pdfPath}.${crypto.randomUUID()}.tmp`
  try {
    await Bun.write(temporaryPdf, await renderPdf(markdown, title, dateLabel, options.meta))
    await rename(temporaryPdf, pdfPath)
  } finally {
    await rm(temporaryPdf, { force: true }).catch((error) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    })
  }
  if (options.resolveVars && markdown !== raw) await Bun.write(sourcePath, markdown)
  return pdfPath
}

// ── Pentest Calls Retain Their Published Artifact Contract ──────
// Existing callers keep the positional signature used by the run-loop boundary.
// REPORT.md remains the source and reports/security-report.pdf the destination.
// New workflows use the generic operation without changing this persisted convention.
// The wrapper also supplies Pentest-specific document indexing metadata.
// ─────────────────────────────────────────────────────────────────
export function renderReportToPdf(
  workareaCwd: string,
  resolveVars?: (markdown: string) => string,
  meta?: ReportMeta,
): Promise<string | undefined> {
  return renderMarkdownReportToPdf({
    workareaCwd,
    sourcePath: "REPORT.md",
    outputPath: "reports/security-report.pdf",
    resolveVars,
    meta: {
      ...meta,
      subject: meta?.subject ?? "Penetration test report — security control evidence (SOC 2, ISO 27001)",
      keywords: meta?.keywords ?? [
        "penetration test",
        "security assessment",
        "SOC 2",
        "ISO 27001:2022",
        "vulnerability",
        "audit evidence",
      ],
    },
  })
}

function resolveReportPath(workareaCwd: string, relativePath: string, field: string, extension: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || path.extname(relativePath).toLowerCase() !== extension) {
    throw new Error(`${field} must be a relative ${extension} path inside the workarea`)
  }
  const workareaRoot = path.resolve(workareaCwd)
  const resolved = path.resolve(workareaRoot, relativePath)
  const fromRoot = path.relative(workareaRoot, resolved)
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error(`${field} must stay inside the workarea`)
  }
  return resolved
}

function isContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function requireContainedSource(workareaCwd: string, sourcePath: string) {
  const sourceInfo = await lstat(sourcePath)
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("sourcePath must be a regular Markdown file")
  const [workareaRoot, resolvedSource] = await Promise.all([realpath(workareaCwd), realpath(sourcePath)])
  if (!isContained(workareaRoot, resolvedSource)) throw new Error("sourcePath resolves outside the workarea")
}

async function requireContainedOutput(workareaCwd: string, outputPath: string) {
  const [workareaRoot, resolvedParent] = await Promise.all([realpath(workareaCwd), realpath(path.dirname(outputPath))])
  if (!isContained(workareaRoot, resolvedParent)) throw new Error("outputPath resolves outside the workarea")
  const outputInfo = await lstat(outputPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (outputInfo && (!outputInfo.isFile() || outputInfo.isSymbolicLink())) {
    throw new Error("outputPath must be a regular PDF file")
  }
}

function titleFromMarkdown(markdown: string) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "Security Report"
}

// ── Unresolved Variables Never Reach Client Deliverables ────────
// The caller first resolves every engagement variable it can access.
// A surviving {{var:name}} denotes an absent or unusable value at that boundary.
// Replacing it with an em dash keeps template syntax out of Markdown and PDF output.
// The caller remains responsible for logging unresolved names in the audit trail.
// ─────────────────────────────────────────────────────────────────
export function stripUnresolvedTemplates(markdown: string): string {
  return markdown.replace(/\{\{\s*var:[^}]+\}\}/g, "—")
}

function formatDate(date: Date) {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
}

async function renderPdf(markdown: string, title: string, dateLabel: string, meta?: ReportMeta) {
  const document = new PDFDocument({
    size: "A4",
    margins: {
      top: page.margin + 18,
      bottom: page.margin,
      left: page.margin,
      right: page.margin,
    },
    info: {
      Title: title,
      Author: "Cyberful",
      Subject: meta?.subject ?? "Application security report",
      Keywords: (
        meta?.keywords ?? ["application security", "security assessment", "vulnerability", "audit evidence"]
      ).join(", "),
      Creator: "Cyberful Security Reporter",
    },
    bufferPages: true,
  })
  document.registerFont(FONT.brand, ebGaramondBoldPath)
  document.registerFont(FONT.heading, ebGaramondPath)
  document.registerFont(FONT.headingBold, ebGaramondBoldPath)
  document.registerFont(FONT.mono, ubuntuMonoPath)

  const chunks: Buffer[] = []
  const ended = new Promise<Buffer>((resolve, reject) => {
    let size = 0
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error("PDF rendering failed", { cause: error }))
    }
    document.on("data", (chunk: Buffer) => {
      if (settled) return
      size += chunk.byteLength
      if (size > MAX_PDF_BYTES) {
        const error = new Error(`Rendered PDF exceeds ${MAX_PDF_BYTES} bytes`)
        fail(error)
        document.destroy(error)
        return
      }
      chunks.push(chunk)
    })
    document.once("error", fail)
    document.once("end", () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks, size))
    })
  })

  // ── Buffered Front Matter Keeps Page References Stable ────────
  // The renderer counts H2 entries before reserving the required TOC pages.
  // Content rendering then records each heading's final content-relative page.
  // The reserved pages are filled only after every destination is known.
  // A post-pass stamps headers and footers without triggering recursive pagination.
  // TOC_PER_PAGE must remain shared by reservation and rendering calculations.
  // ─────────────────────────────────────────────────────────────────
  const blocks = normalizeBlocks(marked.lexer(markdown))
  const tocCount = blocks.filter((b) => b.type === "heading" && b.depth === 2).length
  const tocPages = tocCount ? Math.ceil(tocCount / TOC_PER_PAGE) : 0

  drawCover(document, title, dateLabel, meta)
  for (let i = 0; i < tocPages; i += 1) document.addPage()
  document.addPage()

  const located: { text: string; page: number }[] = []
  const onH2 = (text: string) => {
    document.addNamedDestination(`toc-${located.length}`)
    located.push({ text, page: document.bufferedPageRange().count - 1 - tocPages })
  }
  renderBlocks(document, blocks, onH2)
  if (tocPages) fillToc(document, located)

  const range = document.bufferedPageRange()
  for (let index = range.start + 1; index < range.start + range.count; index += 1) {
    document.switchToPage(index)
    drawShell(document, title, dateLabel, index <= tocPages ? null : index - tocPages)
  }
  document.end()

  return ended
}

function normalizeBlocks(tokens: readonly Tokens.Generic[]): Block[] {
  return tokens
    .map((token): Block | undefined => {
      if (token.type === "heading") return { type: "heading", depth: token.depth, text: cleanText(token.text) }
      if (token.type === "paragraph") return { type: "paragraph", text: cleanText(token.text) }
      if (token.type === "blockquote") return { type: "blockquote", text: cleanText(token.text) }
      if (token.type === "code") return { type: "code", text: token.text, lang: token.lang }
      if (token.type === "hr") return { type: "hr" }
      if (token.type === "list") {
        return {
          type: "list",
          ordered: token.ordered,
          items: token.items.map((item: Tokens.ListItem) => cleanText(item.text)),
        }
      }
      if (token.type === "table") {
        return {
          type: "table",
          header: token.header.map((cell: Tokens.TableCell) => cleanText(cell.text)),
          rows: token.rows.map((row: Tokens.TableCell[]) => row.map((cell) => cleanText(cell.text))),
        }
      }
      return undefined
    })
    .filter((block): block is Block => block !== undefined)
}

function cleanText(input: string) {
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim()
}

// ── Finding Headings Stay Coupled To Their Navigation Target ────
// Every H2 reserves room before its named destination is registered.
// An adjacent severity paragraph moves above the title and becomes a visual badge.
// The title and badge therefore cannot orphan across a page boundary.
// Non-adjacent severity paragraphs retain their original document position.
// The callback records the final page used by the table of contents.
// ─────────────────────────────────────────────────────────────────
function renderBlocks(document: PDFKit.PDFDocument, blocks: Block[], locate?: (text: string) => void) {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const next = blocks[index + 1]
    const severity = block.type === "heading" && next?.type === "paragraph" ? severityIn(next.text) : undefined
    if (block.type === "heading" && block.depth === 2) {
      ensureSpace(document, 72)
      locate?.(block.text)
    }
    if (severity && block.type === "heading") {
      document.moveDown(0.5)
      renderBadge(document, severity)
      renderHeading(document, block, { bold: true, tightTop: true })
      index += 1
      continue
    }
    renderBlock(document, block)
  }
}

function renderBlock(document: PDFKit.PDFDocument, block: Block) {
  if (block.type === "heading") renderHeading(document, block)
  if (block.type === "paragraph") renderParagraph(document, block.text)
  if (block.type === "blockquote") renderQuote(document, block.text)
  if (block.type === "code") renderCode(document, block)
  if (block.type === "list") renderList(document, block)
  if (block.type === "table") renderTable(document, block)
  if (block.type === "hr") renderRule(document)
}

function severityIn(text: string) {
  return text.match(/^Severity:\s*(critical|high|medium|low|informational)/i)?.[1]
}

// ── Spectrum Drawing Leaves The PDF Graphics Stack Untouched ────
// The stamp pass revisits buffered pages and is sensitive to unmatched save/restore pairs.
// These rectangles use neither transforms nor clipping, so no graphics frame is needed.
// Every caller selects its next fill explicitly after the final spectrum segment.
// Avoiding q/Q operations prevents stack desynchronization after switchToPage.
// ─────────────────────────────────────────────────────────────────
function drawSpectrumStripe(document: PDFKit.PDFDocument, x: number, y: number, width: number, height: number) {
  const seg = width / spectrum.length
  spectrum.forEach((color, index) => document.rect(x + index * seg, y, seg + 0.5, height).fill(color))
}

function drawCover(document: PDFKit.PDFDocument, title: string, dateLabel: string, meta?: ReportMeta) {
  const contentWidth = page.width - page.margin * 2
  document.rect(0, 0, page.width, page.height).fill(colors.canvas)
  drawSpectrumStripe(document, 0, 0, page.width, 6)

  document.font(FONT.brand).fontSize(46).fillColor(colors.heading)
  document.text("Cyberful", page.margin, 296, { width: contentWidth, align: "center", lineBreak: false })

  document.font(FONT.body).fontSize(10).fillColor(colors.muted)
  document.text("APPLICATION SECURITY WORKBENCH", page.margin, 360, {
    width: contentWidth,
    align: "center",
    characterSpacing: 2,
    lineBreak: false,
  })

  drawSpectrumStripe(document, page.width / 2 - 70, 392, 140, 3)

  document.font(FONT.heading).fontSize(20).fillColor(colors.ink)
  document.text(title, page.margin, 432, { width: contentWidth, align: "center" })

  document.font(FONT.bodyBold).fontSize(8.5).fillColor(colors.muted)
  document.text(meta?.subtitle ?? "Audit-ready", page.margin, 470, {
    width: contentWidth,
    align: "center",
    characterSpacing: 0.3,
    lineBreak: false,
  })

  const detail = [meta?.target, meta?.reportVersion && `Report ${meta.reportVersion}`, meta?.engagementWindow]
    .filter(Boolean)
    .join("   ·   ")
  let dateY = 494
  if (detail) {
    document.font(FONT.body).fontSize(9).fillColor(colors.muted)
    document.text(detail, page.margin, 492, { width: contentWidth, align: "center", lineBreak: false })
    dateY = 514
  }

  document.font(FONT.body).fontSize(10).fillColor(colors.muted)
  document.text(dateLabel, page.margin, dateY, { width: contentWidth, align: "center", lineBreak: false })

  document.font(FONT.bodyBold).fontSize(9).fillColor(colors.accent)
  document.text("CONFIDENTIAL", page.margin, page.height - 72, {
    width: contentWidth,
    align: "center",
    characterSpacing: 3,
    lineBreak: false,
  })
}

function drawShell(document: PDFKit.PDFDocument, title: string, dateLabel: string, pageNum: number | null) {
  const fullWidth = page.width - page.margin * 2
  const wordmarkTop = 24
  document.font(FONT.brand).fontSize(11).fillColor(colors.heading)
  const wordmarkHeight = document.currentLineHeight()
  document.text("Cyberful", page.margin, wordmarkTop, { lineBreak: false })
  document.font(FONT.body).fontSize(7.5).fillColor(colors.muted)
  const dateY = wordmarkTop + (wordmarkHeight - document.currentLineHeight()) / 2
  document.text(dateLabel, page.margin, dateY, { width: fullWidth, align: "right", lineBreak: false })
  document.text(title, page.margin, 41, { width: fullWidth - 90, ellipsis: true, lineBreak: false })
  if (pageNum !== null) {
    document.text(`Page ${pageNum}`, page.margin, 41, { width: fullWidth, align: "right", lineBreak: false })
  }
  drawSpectrumStripe(document, page.margin, 56, fullWidth, 1.6)

  document.font(FONT.body).fontSize(7).fillColor(colors.muted)
  document.text("CONFIDENTIAL", page.margin, page.height - 28, { characterSpacing: 1.5, lineBreak: false })
}

function fillToc(document: PDFKit.PDFDocument, entries: { text: string; page: number }[]) {
  const contentWidth = page.width - page.margin * 2
  const pageNumWidth = 34
  const rowHeight = 22
  const pages = Math.ceil(entries.length / TOC_PER_PAGE)
  for (let p = 0; p < pages; p += 1) {
    document.switchToPage(1 + p)
    let y = page.margin + 18
    if (p === 0) {
      document.font(FONT.heading).fontSize(22).fillColor(colors.heading)
      document.text("Contents", page.margin, y, { lineBreak: false })
      y += 42
    }
    entries.slice(p * TOC_PER_PAGE, (p + 1) * TOC_PER_PAGE).forEach((entry, k) => {
      document.font(FONT.body).fontSize(11).fillColor(colors.ink)
      document.text(entry.text, page.margin, y, {
        width: contentWidth - pageNumWidth - 10,
        ellipsis: true,
        lineBreak: false,
      })
      document.fillColor(colors.muted)
      document.text(String(entry.page), page.width - page.margin - pageNumWidth, y, {
        width: pageNumWidth,
        align: "right",
        lineBreak: false,
      })
      document.goTo(page.margin, y - 4, contentWidth, rowHeight, `toc-${p * TOC_PER_PAGE + k}`)
      y += rowHeight
    })
  }
}

function ensureSpace(document: PDFKit.PDFDocument, height: number) {
  if (document.y + height <= page.height - page.margin - page.footer) return
  document.addPage()
}

function renderHeading(
  document: PDFKit.PDFDocument,
  block: Extract<Block, { type: "heading" }>,
  opts: { bold?: boolean; tightTop?: boolean } = {},
) {
  const sans = block.depth >= 3
  const size = block.depth === 1 ? 22 : block.depth === 2 ? 18 : block.depth === 3 ? 13 : 11
  ensureSpace(document, size + 22)
  if (!opts.tightTop) document.moveDown(block.depth === 1 ? 0.6 : 0.4)
  const serif = opts.bold ? FONT.headingBold : FONT.heading
  document
    .font(sans ? FONT.bodyBold : serif)
    .fontSize(size)
    .fillColor(colors.heading)
  document.text(block.text, page.margin, document.y, {
    width: page.width - page.margin * 2,
    lineGap: LINE_GAP,
    align: block.depth === 1 ? "center" : "left",
  })
  document.moveDown(block.depth === 1 ? 0.9 : 0.35)
}

function renderParagraph(document: PDFKit.PDFDocument, text: string) {
  if (!text) return
  const severity = severityIn(text)
  ensureSpace(document, severity ? 26 : 18)
  if (severity) {
    renderBadge(document, severity)
    return
  }
  document.font(FONT.body).fontSize(10).fillColor(colors.ink)
  document.text(text, page.margin, document.y, { width: page.width - page.margin * 2, lineGap: LINE_GAP })
  document.moveDown(0.55)
}

function renderBadge(document: PDFKit.PDFDocument, severity: string) {
  const sev = severityColors[severity.toLowerCase()] ?? { bg: colors.accent, fg: "#ffffff" }
  const label = `Severity: ${severity.toUpperCase()}`
  const boxHeight = 18
  document.font(FONT.bodyBold).fontSize(8.5)
  const width = document.widthOfString(label) + 18
  const startY = document.y
  document.roundedRect(page.margin, startY, width, boxHeight, 4).fill(sev.bg)
  const textY = startY + (boxHeight - document.currentLineHeight()) / 2 + 0.5
  document.fillColor(sev.fg).text(label, page.margin + 9, textY, { lineBreak: false })
  document.y = startY + boxHeight + 10
}

function renderQuote(document: PDFKit.PDFDocument, text: string) {
  const height = Math.max(28, document.heightOfString(text, { width: page.width - page.margin * 2 - 20 }) + 8)
  ensureSpace(document, height + 8)
  const startY = document.y
  document.rect(page.margin, startY, 3, height).fill(colors.accent)
  document.font(FONT.italic).fontSize(9).fillColor(colors.muted)
  document.text(text, page.margin + 14, startY + 4, { width: page.width - page.margin * 2 - 20, lineGap: LINE_GAP })
  document.y = startY + height + 8
}

function renderCode(document: PDFKit.PDFDocument, block: Extract<Block, { type: "code" }>) {
  const pad = 10
  const labelHeight = block.lang ? 12 : 0
  document.font(FONT.mono).fontSize(8)

  // ── Oversized Code Blocks Degrade Visibly ─────────────────────
  // PDFKit continued text cannot preserve highlighted runs across embedded newlines.
  // Each source line is therefore positioned independently inside one dark panel.
  // A panel cannot span pages without losing its background and line-number geometry.
  // When the panel reaches one page, an explicit omission row replaces hidden lines.
  // The complete evidence remains available in the Markdown report beside the PDF.
  // ─────────────────────────────────────────────────────────────────
  const lineHeight = document.currentLineHeight() + 2
  const lines = splitIntoLines(highlightRuns(block.text.replace(/\n+$/, ""), block.lang))
  const maxBox = page.height - page.margin * 2 - page.footer - 18
  const boxHeight = Math.min(lines.length * lineHeight + pad * 2 + labelHeight, maxBox)
  ensureSpace(document, boxHeight + 8)
  const startY = document.y
  document.roundedRect(page.margin, startY, page.width - page.margin * 2, boxHeight, 4).fill(codeBg)
  if (block.lang) {
    document.font(FONT.mono).fontSize(6.5).fillColor(codeColors["hljs-comment"])
    document.text(block.lang.toUpperCase(), page.margin + pad, startY + pad, { lineBreak: false })
  }
  document.font(FONT.mono).fontSize(8)
  const top = startY + pad + labelHeight
  const maxLines = Math.floor((boxHeight - pad * 2 - labelHeight) / lineHeight)
  const visibleSourceLines = lines.length > maxLines ? Math.max(0, maxLines - 1) : lines.length
  const shown = lines.slice(0, visibleSourceLines)
  if (visibleSourceLines < lines.length) {
    shown.push([
      {
        text: `… ${lines.length - visibleSourceLines} lines omitted; see the Markdown source`,
        color: codeColors["hljs-comment"],
      },
    ])
  }
  const numberWidth = document.widthOfString(String(Math.max(1, visibleSourceLines)))
  const gutterWidth = 4 + numberWidth + 8
  const numberX = page.margin + pad + 4
  const separatorX = page.margin + pad + numberWidth + 8
  const x0 = page.margin + pad + gutterWidth
  document.lineWidth(0.6)
  document
    .moveTo(separatorX, top)
    .lineTo(separatorX, top + shown.length * lineHeight - 2)
    .strokeColor("#23262b")
    .stroke()
  document.lineWidth(1)
  shown.forEach((segments, row) => {
    const y = top + row * lineHeight
    document.font(FONT.mono).fontSize(8).fillColor("#565e69")
    const lineNumber = row < visibleSourceLines ? String(row + 1) : "…"
    document.text(lineNumber, numberX, y, { width: numberWidth, align: "right", lineBreak: false })
    segments.forEach((segment, index) => {
      document.fillColor(segment.color)
      const continued = index < segments.length - 1
      if (index === 0) document.text(segment.text, x0, y, { lineBreak: false, continued })
      else document.text(segment.text, { lineBreak: false, continued })
    })
  })
  document.y = startY + boxHeight + 8
}

type Segment = { text: string; color: string }

function splitIntoLines(runs: Segment[]): Segment[][] {
  const lines: Segment[][] = [[]]
  for (const run of runs) {
    run.text.split("\n").forEach((part, index) => {
      if (index > 0) lines.push([])
      if (part) lines[lines.length - 1].push({ text: part, color: run.color })
    })
  }
  return lines
}

function highlightRuns(code: string, lang?: string): Segment[] {
  const runs: Segment[] = []
  const walk = (node: HighlightNode, color: string) => {
    if (node.type === "text") {
      if (node.value) runs.push({ text: node.value, color })
      return
    }
    if (node.type !== "element") return
    const classes = Array.isArray(node.properties.className)
      ? node.properties.className.filter((name): name is string => typeof name === "string")
      : []
    const mapped = classes.find((name) => name in codeColors)
    node.children.forEach((child) => walk(child, mapped ? codeColors[mapped] : color))
  }
  highlightTree(code, lang).children.forEach((child) => walk(child, codeColors.default))
  return runs.length ? runs : [{ text: code, color: codeColors.default }]
}

// ── Highlighting Is An Optional Presentation Boundary ───────────
// A declared language is used only when lowlight has registered its grammar.
// Undeclared languages use automatic detection supplied by the dependency.
// Third-party detection failures must not prevent delivery of the security report.
// Plain text preserves the evidence exactly while sacrificing only token colours.
// ─────────────────────────────────────────────────────────────────
function highlightTree(code: string, lang?: string): HighlightRoot {
  if (lang && lowlight.registered(lang)) return lowlight.highlight(lang, code)
  try {
    return lowlight.highlightAuto(code)
  } catch {
    return { type: "root", children: [{ type: "text", value: code }] }
  }
}

function renderList(document: PDFKit.PDFDocument, block: Extract<Block, { type: "list" }>) {
  block.items.forEach((item, index) => {
    ensureSpace(document, 20)
    const startY = document.y
    document.font(FONT.bodyBold).fontSize(9).fillColor(colors.accent)
    document.text(block.ordered ? `${index + 1}.` : "-", page.margin, startY, { width: 22 })
    document.font(FONT.body).fontSize(10).fillColor(colors.ink)
    document.text(item, page.margin + 24, startY, { width: page.width - page.margin * 2 - 24, lineGap: LINE_GAP })
    document.moveDown(0.25)
  })
  document.moveDown(0.4)
}

// ── Tables Paginate Without Losing Evidence ─────────────────────
// Every cell is measured and wrapped using the same font used for rendering.
// Rows remain indivisible; a row that cannot fit begins on a fresh page.
// Continuation pages repeat the header so column meaning remains visible.
// The first row is reserved with its header to prevent an orphaned heading band.
// No fixed-height clipping is permitted for report evidence.
// ─────────────────────────────────────────────────────────────────
function renderTable(document: PDFKit.PDFDocument, block: Extract<Block, { type: "table" }>) {
  const avail = page.width - page.margin * 2
  const cols = block.header.length
  if (cols === 0) return
  const size = 8.5
  const padX = 6
  const padY = 4
  const bottom = page.height - page.margin - page.footer

  // ── Column Widths Balance Tokens And Content Volume ───────────
  // Each column first reserves space for its widest PDFKit-breakable token.
  // Whitespace and hyphens define those tokens because PDFKit can wrap at both.
  // Remaining width is shared by bounded longest-cell weights, favoring dense columns.
  // If minimum widths exceed the page, proportional compression preserves their ratio.
  // This keeps short labels readable without starving narrative evidence columns.
  // ─────────────────────────────────────────────────────────────────
  const tokens = (value: string | undefined) => (value ?? "").split(/[\s-]+/).filter(Boolean)
  document.fontSize(size)
  const minWidth = block.header.map((_, c) => {
    let widest = 0
    const measure = (value: string | undefined, bold: boolean) => {
      document.font(bold ? FONT.bodyBold : FONT.body)
      for (const token of tokens(value)) widest = Math.max(widest, document.widthOfString(token))
    }
    measure(block.header[c], true)
    for (const row of block.rows) measure(row[c], false)
    return widest + padX * 2 + 2
  })
  const weights = block.header.map((_, c) => {
    let longest = (block.header[c] ?? "").length
    for (const row of block.rows) longest = Math.max(longest, (row[c] ?? "").length)
    return Math.max(6, Math.min(60, longest))
  })
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1
  const minTotal = minWidth.reduce((a, b) => a + b, 0)
  const widths =
    minTotal >= avail
      ? minWidth.map((m) => (m / minTotal) * avail)
      : weights.map((w, c) => minWidth[c] + (w / weightSum) * (avail - minTotal))

  const measureRow = (cells: string[], bold: boolean) => {
    document.font(bold ? FONT.bodyBold : FONT.body).fontSize(size)
    let tallest = 0
    for (let c = 0; c < cols; c += 1) {
      tallest = Math.max(tallest, document.heightOfString(cells[c] ?? "", { width: widths[c] - padX * 2, lineGap: 1 }))
    }
    return tallest + padY * 2
  }

  const drawRow = (cells: string[], bold: boolean) => {
    const h = measureRow(cells, bold)
    if (document.y + h > bottom) {
      document.addPage()
      if (!bold) drawRow(block.header, true)
    }
    const y = document.y
    if (bold) document.rect(page.margin, y, avail, h).fill(colors.panel)
    document
      .font(bold ? FONT.bodyBold : FONT.body)
      .fontSize(size)
      .fillColor(bold ? colors.heading : colors.ink)
    let x = page.margin
    for (let c = 0; c < cols; c += 1) {
      document.text(cells[c] ?? "", x + padX, y + padY, { width: widths[c] - padX * 2, lineGap: 1 })
      x += widths[c]
    }
    document
      .moveTo(page.margin, y + h)
      .lineTo(page.margin + avail, y + h)
      .strokeColor(colors.faint)
      .lineWidth(0.5)
      .stroke()
    document.y = y + h
  }

  ensureSpace(document, measureRow(block.header, true) + measureRow(block.rows[0] ?? block.header, false))
  document.moveDown(0.2)
  document
    .moveTo(page.margin, document.y)
    .lineTo(page.margin + avail, document.y)
    .strokeColor(colors.faint)
    .lineWidth(0.5)
    .stroke()
  drawRow(block.header, true)
  for (const row of block.rows) drawRow(row, false)
  document.lineWidth(1)
  document.moveDown(0.5)
}

function renderRule(document: PDFKit.PDFDocument) {
  ensureSpace(document, 16)
  document
    .moveTo(page.margin, document.y + 6)
    .lineTo(page.width - page.margin, document.y + 6)
    .strokeColor(colors.faint)
    .stroke()
  document.y += 18
}
