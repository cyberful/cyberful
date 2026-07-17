#!/usr/bin/env bun
// ── Code Canon Verification ──────────────────────────────────────
// Verifies repository-owned source headers, framed design notes, documentation
// references, and TypeScript's ban on explicit `any` before other checks run.
// → CODE.md — defines the contracts enforced by this repository check.
// → cyberful/package.json — runs this check as the first typecheck gate.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { stat } from "node:fs/promises"
import ts from "typescript"

const repositoryRoot = path.resolve(import.meta.dir, "../..")
const codeExtensions = new Set([".cjs", ".js", ".mjs", ".py", ".sh", ".sql", ".ts", ".tsx"])
const ignoredSegments = new Set([
  ".browsers",
  ".git",
  ".venv",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
  "site",
])
const ownedRoots = ["cyberful", "mcps", "scripts"] as const

export type Violation = {
  file: string
  line: number
  message: string
}

function isIgnored(relativePath: string) {
  return relativePath.split("/").some((segment) => ignoredSegments.has(segment))
}

function isCodeCandidate(relativePath: string) {
  if (isIgnored(relativePath)) return false
  if (codeExtensions.has(path.extname(relativePath))) return true
  return relativePath.includes("/bin/") && path.extname(relativePath) === ""
}

async function collectCodeFiles() {
  const files = new Set<string>()
  const glob = new Bun.Glob("**/*")

  await Promise.all(
    ownedRoots.map(async (ownedRoot) => {
      for await (const relativePath of glob.scan({
        cwd: path.join(repositoryRoot, ownedRoot),
        dot: true,
        followSymlinks: false,
        onlyFiles: true,
      })) {
        const repositoryPath = path.posix.join(ownedRoot, relativePath)
        if (!isCodeCandidate(repositoryPath)) continue
        if (path.extname(repositoryPath) === "") {
          const firstLine = (await Bun.file(path.join(repositoryRoot, repositoryPath)).text()).split(/\r?\n/, 1)[0]
          if (!firstLine.startsWith("#!")) continue
        }
        files.add(repositoryPath)
      }
    }),
  )

  return [...files].sort()
}

function machinePreambleLength(lines: string[]) {
  let index = 0
  if (lines[index]?.startsWith("#!")) index++
  if (/^#.*(?:coding[:=]\s*[-\w.]+|-*-\s*coding\s*:)/.test(lines[index] ?? "")) index++
  return index
}

const openingFrame = /^\s*(\/\/|#|--) ── (.+?) ─{3,}\s*$/
const closingFrame = /^\s*(\/\/|#|--) ─{20,}\s*$/
const ornamentalCandidate = /^\s*(\/\/|#|--) ──/
const asciiRegionMarker = /^\s*(?:\/\/|#|--)\s+(?:-{8,}|={8,})\s*$/

function commentBody(line: string, prefix: string) {
  const match = line.match(new RegExp(`^\\s*${prefix.replaceAll("/", "\\/")} ?(.*)$`))
  return match?.[1]
}

function findClosingFrame(lines: string[], openingIndex: number, prefix: string) {
  for (let index = openingIndex + 1; index < lines.length; index++) {
    const match = lines[index].match(closingFrame)
    if (match?.[1] === prefix) return index
    if (lines[index].match(openingFrame)?.[1] === prefix) return -1
  }
  return -1
}

function inspectOrnamentalSyntax(file: string, lines: string[], violations: Violation[]) {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (ornamentalCandidate.test(line) && !openingFrame.test(line) && !closingFrame.test(line)) {
      violations.push({ file, line: index + 1, message: "malformed ornamental frame separator" })
    }
    if (asciiRegionMarker.test(line)) {
      violations.push({ file, line: index + 1, message: "bare ASCII region markers are forbidden" })
    }
  }
}

function inspectHeader(file: string, lines: string[], violations: Violation[]) {
  const headerIndex = machinePreambleLength(lines)
  const opening = lines[headerIndex]?.match(openingFrame)
  if (!opening) {
    violations.push({ file, line: headerIndex + 1, message: "missing ornamental file header" })
    return -1
  }

  const prefix = opening[1]
  const closingIndex = findClosingFrame(lines, headerIndex, prefix)
  if (closingIndex < 0) {
    violations.push({ file, line: headerIndex + 1, message: "file header has no matching closing separator" })
    return headerIndex
  }

  let proseLines = 0
  for (let index = headerIndex + 1; index < closingIndex; index++) {
    const body = commentBody(lines[index], prefix)
    if (body === undefined) {
      violations.push({ file, line: index + 1, message: "file header contains a non-comment line" })
      continue
    }
    if (/^(?:Owns|Connects):/.test(body)) {
      violations.push({
        file,
        line: index + 1,
        message: "use plain prose and `→`; Owns:/Connects: labels are forbidden",
      })
    }
    if (body.startsWith("→")) {
      const relationship = body.match(/^→ ([^\s]+) — \S.+$/)
      if (!relationship) {
        violations.push({ file, line: index + 1, message: "relationship must be `→ root/relative/path — explanation`" })
      }
      continue
    }
    if (body.startsWith("@docs/")) continue
    if (body.trim() !== "") proseLines++
  }
  if (proseLines === 0) {
    violations.push({ file, line: headerIndex + 2, message: "file header requires responsibility prose" })
  }
  return closingIndex
}

function inspectLiterateSections(file: string, lines: string[], headerClosingIndex: number, violations: Violation[]) {
  for (let openingIndex = Math.max(headerClosingIndex + 1, 0); openingIndex < lines.length; openingIndex++) {
    const opening = lines[openingIndex].match(openingFrame)
    if (!opening) continue

    const prefix = opening[1]
    const closingIndex = findClosingFrame(lines, openingIndex, prefix)
    if (closingIndex < 0) {
      violations.push({ file, line: openingIndex + 1, message: "literate section has no matching closing separator" })
      continue
    }

    let substantiveLines = 0
    for (let index = openingIndex + 1; index < closingIndex; index++) {
      const body = commentBody(lines[index], prefix)
      if (body === undefined) continue
      if (body.trim() === "" || body.startsWith("@docs/") || body.startsWith("→")) continue
      substantiveLines++
    }
    if (substantiveLines < 4 || substantiveLines > 8) {
      violations.push({
        file,
        line: openingIndex + 1,
        message: `literate prose has ${substantiveLines} substantive lines; expected 4–8`,
      })
    }
    openingIndex = closingIndex
  }
}

function inspectUnframedDesignNotes(file: string, lines: string[], violations: Violation[]) {
  let openingIndex = -1
  let substantiveLines = 0

  const flush = () => {
    if (openingIndex >= 0 && substantiveLines >= 4) {
      violations.push({
        file,
        line: openingIndex + 1,
        message: "multi-line design note requires a complete ornamental frame",
      })
    }
    openingIndex = -1
    substantiveLines = 0
  }

  for (let index = machinePreambleLength(lines); index < lines.length; index++) {
    const opening = lines[index].match(openingFrame)
    if (opening) {
      flush()
      const closingIndex = findClosingFrame(lines, index, opening[1])
      if (closingIndex >= 0) index = closingIndex
      continue
    }

    const comment = lines[index].match(/^\s*(\/\/|#|--) ?(.*)$/)
    if (!comment) {
      flush()
      continue
    }

    if (openingIndex < 0) openingIndex = index
    const body = comment[2].trim()
    if (body && !body.startsWith("@docs/") && !body.startsWith("→")) substantiveLines++
  }

  flush()
}

function inspectExplicitAny(file: string, source: string, violations: Violation[]) {
  if (!/\.tsx?$/.test(file)) return
  const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind)

  function visit(node: ts.Node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      violations.push({
        file,
        line: position.line + 1,
        message: "explicit `any` is forbidden; validate or narrow `unknown`",
      })
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
}

async function inspectReferences(file: string, lines: string[], violations: Violation[]) {
  for (let index = 0; index < lines.length; index++) {
    const comment = lines[index].match(/^\s*(?:\/\/|#|--) ?(.*)$/)
    if (!comment) continue
    const body = comment[1]
    const reference = body.startsWith("@docs/")
      ? body.slice(1)
      : body.startsWith("→ ")
        ? body.slice(2).split(" —", 1)[0]
        : undefined
    if (!reference) continue

    try {
      await stat(path.join(repositoryRoot, reference))
    } catch {
      violations.push({ file, line: index + 1, message: `broken repository reference: ${reference}` })
    }
  }
}

export function inspectCodeSource(file: string, source: string) {
  const violations: Violation[] = []
  const lines = source.split(/\r?\n/)
  inspectOrnamentalSyntax(file, lines, violations)
  const headerClosingIndex = inspectHeader(file, lines, violations)
  inspectLiterateSections(file, lines, headerClosingIndex, violations)
  inspectUnframedDesignNotes(file, lines, violations)
  inspectExplicitAny(file, source, violations)
  return violations
}

async function main() {
  const violations: Violation[] = []
  const requestedPaths = process.argv.slice(2).map((value) => {
    const clean = value.replace(/^\.\//, "").replace(/\/$/, "")
    if (ownedRoots.some((ownedRoot) => clean === ownedRoot || clean.startsWith(`${ownedRoot}/`))) return clean
    return path.relative(repositoryRoot, path.resolve(clean)).replaceAll("\\", "/")
  })
  const discoveredFiles = await collectCodeFiles()
  const files =
    requestedPaths.length === 0
      ? discoveredFiles
      : discoveredFiles.filter((file) =>
          requestedPaths.some((requested) => file === requested || file.startsWith(`${requested}/`)),
        )

  if (files.length === 0 && requestedPaths.length > 0) {
    console.error(`No repository-owned code files matched: ${requestedPaths.join(", ")}`)
    process.exit(1)
  }

  // ── Canon Verification Is Deliberately Sequential ────────────────
  // A repository-wide migration can contain hundreds of source files and references.
  // Launching every filesystem read and stat together would make the verification gate
  // itself an unbounded concurrency offender. Sequential traversal bounds resource use
  // and keeps diagnostics reproducible across developer machines and CI; the final sort
  // remains a defensive guarantee when independent inspectors append violations.
  // ─────────────────────────────────────────────────────────────────
  for (const file of files) {
    const source = await Bun.file(path.join(repositoryRoot, file)).text()
    const lines = source.split(/\r?\n/)
    violations.push(...inspectCodeSource(file, source))
    await inspectReferences(file, lines, violations)
  }

  violations.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.file}:${violation.line}: ${violation.message}`)
    }
    console.error(
      `\n${violations.length} CODE.md violation${violations.length === 1 ? "" : "s"} across ${files.length} code files.`,
    )
    process.exit(1)
  }

  console.log(`CODE.md verification passed for ${files.length} code files.`)
}

if (import.meta.main) await main()
