// ── Pi Skill Registry And Read Capability ────────────────────────
// Discovers skill packages only beneath caller-supplied trusted roots, emits
// their compact prompt catalog, and confines progressive reads to each package.
// → cyberful/src/subsystem/prompt-compiler.ts — renders the compact catalog.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core"
import matter from "gray-matter"
import { Type } from "typebox"
import type { PromptSkill } from "./prompt-compiler"
import { assertFirstPartySkillName } from "./skill-naming"

const DEFAULT_MAX_FILE_BYTES = 512 * 1024
const MAX_INDEX_TERMS = 512
const MAX_INDEX_TERM_CHARACTERS = 256
const FORBIDDEN_AMBIENT_DIRECTORIES = new Set([".agents", ".claude", ".codex", ".pi"])
const IMAGE_MEDIA_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
])

const SkillReadParameters = Type.Object(
  {
    skill: Type.String({
      minLength: 1,
      description: "Skill name or exact SKILL.md location from the Cyberful skill catalog.",
    }),
    path: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Explicit package-relative reference, agent instruction, script, template, or asset path. Omit to read SKILL.md.",
      }),
    ),
  },
  { additionalProperties: false },
)

const SkillSearchParameters = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      maxLength: 200,
      description: 'Skill name or capability to find. Use "*" to enumerate every available skill.',
    }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 8 })),
    cursor: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 20,
        pattern: "^(0|[1-9][0-9]*)$",
        description: "Opaque cursor returned by the previous skill_search page for the same query.",
      }),
    ),
  },
  { additionalProperties: false },
)

export interface SkillRoot {
  readonly path: string
  readonly origin: "first_party" | "extension"
}

export interface DiscoverSkillOptions {
  readonly roots: readonly (string | SkillRoot)[]
  readonly maxFileBytes?: number
}

export interface SkillReadRequest {
  readonly skill: string
  readonly path?: string
}

export interface SkillReadDetails {
  readonly skill: string
  readonly location: string
  readonly requestedPath: string
  readonly bytes: number
  readonly mediaType: string
  readonly kind: "instructions" | "resource"
}

export interface SkillSearchDetails {
  readonly query: string
  readonly total: number
  readonly returned: number
  readonly nextCursor?: string
}

export interface SkillRegistry {
  readonly catalog: readonly PromptSkill[]
  readonly tool: AgentTool<typeof SkillReadParameters, SkillReadDetails>
  readonly searchTool: AgentTool<typeof SkillSearchParameters, SkillSearchDetails>
  readonly read: (request: SkillReadRequest, signal?: AbortSignal) => Promise<AgentToolResult<SkillReadDetails>>
}

interface SkillPackage {
  readonly catalog: PromptSkill
  readonly root: string
}

interface ParsedMetadata {
  readonly name: string
  readonly description: string
  readonly triggers: readonly string[]
  readonly category: string
  readonly searchTerms: readonly string[]
}

function required(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is empty`)
  return normalized
}

function abortIfRequested(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException("Skill read was aborted.", "AbortError")
}

function boundedFileSize(value = DEFAULT_MAX_FILE_BYTES): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("Pi skill maxFileBytes must be a positive safe integer")
  return value
}

function containsAmbientDirectory(value: string): boolean {
  return path
    .resolve(value)
    .split(path.sep)
    .some((component) => FORBIDDEN_AMBIENT_DIRECTORIES.has(component.toLowerCase()))
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function triggerList(value: unknown, label: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`${label} must be an array of strings`)
  return value.map((item) => item.trim()).filter(Boolean)
}

function termList(value: unknown, label: string): readonly string[] {
  if (value === undefined) return []
  if (typeof value === "string") return value.trim() ? [value.trim()] : []
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`${label} must be a string or an array of strings`)
  return value.map((item) => item.trim()).filter(Boolean)
}

function optionalCategory(value: unknown, label: string): string | undefined {
  if (value === undefined) return
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  return value.trim() || undefined
}

function validatedIndexTerms(values: readonly string[], label: string): readonly string[] {
  const unique = [...new Set(values)]
  if (unique.length > MAX_INDEX_TERMS) throw new Error(`${label} exceeds ${MAX_INDEX_TERMS} entries`)
  for (const value of unique)
    if (value.length > MAX_INDEX_TERM_CHARACTERS || /[\u0000-\u001f\u007f]/.test(value))
      throw new Error(`${label} contains an invalid term`)
  return unique
}

function frameworkValueTerms(value: unknown, label: string): readonly string[] {
  if (value === undefined) return []
  if (typeof value === "string") return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) return value.flatMap((item) => frameworkValueTerms(item, label))
  if (isRecord(value)) return Object.entries(value).flatMap(([key, item]) => [key, ...frameworkValueTerms(item, label)])
  throw new Error(`${label} must contain strings, arrays, or string-valued mappings`)
}

function indexedFrameworkTerms(data: Readonly<Record<string, unknown>>): readonly string[] {
  const frameworkName = /(mitre|nist|atlas|d3fend)/i
  const direct = Object.entries(data).flatMap(([name, value]) =>
    frameworkName.test(name) ? frameworkValueTerms(value, `skill framework '${name}'`) : [],
  )
  const nested = isRecord(data.frameworks)
    ? Object.entries(data.frameworks).flatMap(([name, value]) =>
        frameworkName.test(name) ? frameworkValueTerms(value, `skill framework '${name}'`) : [],
      )
    : []
  return [...direct, ...nested]
}

function parseMetadata(source: string, location: string): ParsedMetadata {
  const parsed = matter(source)
  if (!isRecord(parsed.data)) throw new Error(`skill '${location}' frontmatter must be an object`)
  if (typeof parsed.data.name !== "string")
    throw new Error(`skill '${location}' frontmatter must contain a string name`)
  if (typeof parsed.data.description !== "string")
    throw new Error(`skill '${location}' frontmatter must contain a string description`)
  if (!parsed.content.trim()) throw new Error(`skill '${location}' instructions are empty`)

  const name = required(parsed.data.name, `skill '${location}' name`)
  if (name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error(`skill '${location}' name is invalid`)
  const description = required(parsed.data.description, `skill '${name}' description`)
  const metadata = isRecord(parsed.data.metadata) ? parsed.data.metadata : {}
  const indexedValue = (field: string): unknown => parsed.data[field] ?? metadata[field]
  const triggers = [
    ...triggerList(indexedValue("triggers"), `skill '${name}' triggers`),
    ...triggerList(indexedValue("keywords"), `skill '${name}' keywords`),
  ]
  const tags = termList(indexedValue("tags"), `skill '${name}' tags`)
  const frameworks = [...indexedFrameworkTerms(parsed.data), ...indexedFrameworkTerms(metadata)]
  const category =
    optionalCategory(indexedValue("subdomain"), `skill '${name}' subdomain`) ??
    optionalCategory(indexedValue("domain"), `skill '${name}' domain`) ??
    "uncategorized"
  if (category.length > 128 || /[\u0000-\u001f\u007f]/.test(category))
    throw new Error(`skill '${name}' category is invalid`)
  const uniqueTriggers = validatedIndexTerms(triggers, `skill '${name}' triggers`)
  return {
    name,
    description,
    triggers: uniqueTriggers,
    category,
    searchTerms: validatedIndexTerms([...uniqueTriggers, ...tags, ...frameworks], `skill '${name}' search terms`),
  }
}

async function readRegularFile(filename: string, maxFileBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  abortIfRequested(signal)
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW
  const file = await open(filename, constants.O_RDONLY | noFollow)
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error(`Pi skill path '${filename}' is not a regular file`)
    if (metadata.size > maxFileBytes)
      throw new Error(`Pi skill file '${filename}' exceeds the ${maxFileBytes}-byte limit`)
    const bytes = await file.readFile()
    if (bytes.byteLength > maxFileBytes)
      throw new Error(`Pi skill file '${filename}' exceeds the ${maxFileBytes}-byte limit`)
    abortIfRequested(signal)
    return bytes
  } finally {
    await file.close()
  }
}

function decodeText(bytes: Uint8Array, filename: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error(`Pi skill file '${filename}' is not valid UTF-8 text`, { cause: error })
  }
}

async function canonicalTrustedRoot(root: string | SkillRoot): Promise<SkillRoot> {
  const origin = typeof root === "string" ? "first_party" : root.origin
  const requested = path.resolve(required(typeof root === "string" ? root : root.path, "Pi skill root"))
  if (containsAmbientDirectory(requested))
    throw new Error(`Pi skill root '${requested}' is an ambient agent configuration directory`)
  const metadata = await lstat(requested)
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error(`Pi skill root '${requested}' must be a non-symlink directory`)
  return { path: await realpath(requested), origin }
}

// ── Explicit Roots Are The Entire Discovery Boundary ─────────────
// The registry has no workspace, home, repository, or Pi configuration input,
// so ambient skill discovery is impossible by construction. Traversal stops at
// each package and never follows a symbolic link. Root order remains meaningful:
// a later explicitly trusted root may replace an earlier package with the same
// name, while deterministic sorting keeps the compiled catalog reproducible.
//
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────
async function discoverPackages(
  root: string,
  origin: SkillRoot["origin"],
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<readonly SkillPackage[]> {
  const packages: SkillPackage[] = []

  const visit = async (directory: string): Promise<void> => {
    abortIfRequested(signal)
    const entries = (await readdir(directory, { withFileTypes: true })).toSorted((left, right) =>
      compareText(left.name, right.name),
    )
    const manifest = entries.find((entry) => entry.name === "SKILL.md")
    if (manifest) {
      const location = path.join(directory, manifest.name)
      const metadata = await lstat(location)
      if (!metadata.isSymbolicLink() && metadata.isFile()) {
        const source = decodeText(await readRegularFile(location, maxFileBytes, signal), location)
        const parsed = parseMetadata(source, location)
        if (origin === "first_party") assertFirstPartySkillName(parsed.name, location)
        packages.push({
          catalog: {
            name: parsed.name,
            description: parsed.description,
            ...(parsed.triggers.length > 0 ? { triggers: parsed.triggers } : {}),
            origin,
            category: origin === "first_party" && parsed.category === "uncategorized" ? "cyberful" : parsed.category,
            ...(parsed.searchTerms.length > 0 ? { searchTerms: parsed.searchTerms } : {}),
            location,
          },
          root: directory,
        })
        return
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || FORBIDDEN_AMBIENT_DIRECTORIES.has(entry.name.toLowerCase())) continue
      const child = path.join(directory, entry.name)
      const metadata = await lstat(child)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue
      await visit(child)
    }
  }

  await visit(root)
  return packages
}

function explicitResourcePath(packageRoot: string, requestedPath: string): string {
  if (path.isAbsolute(requestedPath) || requestedPath.includes("\u0000"))
    throw new Error("Pi skill resource path must be a package-relative path")
  const components = requestedPath.split(/[\\/]/)
  if (
    components.some(
      (component) =>
        !component ||
        component === "." ||
        component === ".." ||
        FORBIDDEN_AMBIENT_DIRECTORIES.has(component.toLowerCase()),
    )
  )
    throw new Error("Pi skill resource path contains a forbidden traversal component")
  const resolved = path.resolve(packageRoot, ...components)
  if (!inside(packageRoot, resolved)) throw new Error("Pi skill resource path escapes its package")
  return resolved
}

async function rejectSymlinkComponents(packageRoot: string, filename: string): Promise<void> {
  const relative = path.relative(packageRoot, filename)
  let current = packageRoot
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component)
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) throw new Error(`Pi skill path '${current}' must not be a symbolic link`)
    if (current !== filename && !metadata.isDirectory())
      throw new Error(`Pi skill path '${current}' is not a directory`)
  }
  const canonical = await realpath(filename)
  if (!inside(packageRoot, canonical)) throw new Error("Pi skill resource path escapes its package")
}

function contentForFile(bytes: Uint8Array, filename: string) {
  const mediaType = IMAGE_MEDIA_TYPES.get(path.extname(filename).toLowerCase())
  if (mediaType)
    return {
      content: [{ type: "image" as const, data: Buffer.from(bytes).toString("base64"), mimeType: mediaType }],
      mediaType,
    }
  return {
    content: [{ type: "text" as const, text: decodeText(bytes, filename) }],
    mediaType: "text/plain; charset=utf-8",
  }
}

function createReader(packages: readonly SkillPackage[], maxFileBytes: number): SkillRegistry["read"] {
  const byName = new Map(packages.map((skill) => [skill.catalog.name, skill]))
  const byLocation = new Map(packages.map((skill) => [skill.catalog.location, skill]))

  return async (request, signal) => {
    abortIfRequested(signal)
    const locator = required(request.skill, "Pi skill locator")
    const skill = byName.get(locator) ?? byLocation.get(path.resolve(locator))
    if (!skill) throw new Error(`Pi skill '${locator}' is not available; use skill_search to find an available skill`)
    const requestedPath = request.path === undefined ? "SKILL.md" : required(request.path, "Pi skill resource path")
    const filename =
      request.path === undefined ? skill.catalog.location : explicitResourcePath(skill.root, requestedPath)
    await rejectSymlinkComponents(skill.root, filename)
    const bytes = await readRegularFile(filename, maxFileBytes, signal)
    const rendered = contentForFile(bytes, filename)
    return {
      content: rendered.content,
      details: {
        skill: skill.catalog.name,
        location: filename,
        requestedPath,
        bytes: bytes.byteLength,
        mediaType: rendered.mediaType,
        kind: request.path === undefined ? "instructions" : "resource",
      },
    }
  }
}

// ── Search Discovers Metadata Without Loading Instructions ──────
// Exact and prefix name matches dominate a deterministic lexical score. The
// search result contains only bounded indexed metadata: it neither exposes host
// paths nor reads a skill body, and therefore cannot mark a skill as used.
// Wildcard enumeration and numeric offset cursors share the same stable name
// order used by the prompt catalog.
// ─────────────────────────────────────────────────────────────────
function normalizedSearchTokens(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    ),
  ]
}

function compactDescription(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= 240) return normalized
  const prefix = normalized.slice(0, 239)
  const boundaries = [/[.!?](?=\s|$)/g, /[;,:](?=\s|$)/g, /\s+/g]
  for (const pattern of boundaries) {
    let boundary = -1
    for (const match of prefix.matchAll(pattern)) boundary = match.index ?? boundary
    if (boundary < 0) continue
    const end = pattern.source === "\\s+" ? boundary : boundary + 1
    const excerpt = prefix.slice(0, end).trimEnd()
    if (excerpt) return `${excerpt}…`
  }
  return ""
}

function searchScore(skill: PromptSkill, query: string): number | undefined {
  const normalizedQuery = query.toLowerCase().trim()
  const name = skill.name.toLowerCase()
  if (name === normalizedQuery) return 1_000_000
  if (name.startsWith(normalizedQuery)) return 500_000

  const tokens = normalizedSearchTokens(normalizedQuery)
  if (tokens.length === 0) return
  const category = (skill.category ?? "uncategorized").toLowerCase()
  const description = (skill.description ?? "").toLowerCase()
  const triggers = (skill.triggers ?? []).map((term) => term.toLowerCase())
  const searchTerms = (skill.searchTerms ?? []).map((term) => term.toLowerCase())
  let score = 0
  let matched = 0
  for (const token of tokens) {
    if (name === token) score += 100_000
    else if (name.startsWith(token)) score += 50_000
    else if (name.includes(token)) score += 20_000
    else if (category === token) score += 12_000
    else if (category.includes(token)) score += 8_000
    else if (triggers.some((term) => term.includes(token))) score += 4_000
    else if (searchTerms.some((term) => term.includes(token))) score += 3_000
    else if (description.includes(token)) score += 500
    else continue
    matched++
  }
  if (matched === 0) return
  return score + Math.round((matched / tokens.length) * 1_000)
}

function compareSkillNames(left: PromptSkill, right: PromptSkill): number {
  return compareText(left.name, right.name)
}

function matchingTerms(skill: PromptSkill, query: string): readonly string[] {
  if (query === "*") return []
  const tokens = normalizedSearchTokens(query)
  const candidates = [
    skill.name,
    skill.category ?? "uncategorized",
    ...(skill.triggers ?? []),
    ...(skill.searchTerms ?? []),
  ]
  const matched = candidates.filter((candidate) => {
    const normalized = candidate.toLowerCase()
    return tokens.some((token) => normalized.includes(token))
  })
  if (tokens.some((token) => (skill.description ?? "").toLowerCase().includes(token))) matched.push(...tokens)
  return [...new Set(matched)].slice(0, 12)
}

function createSearchTool(catalog: readonly PromptSkill[]): SkillRegistry["searchTool"] {
  return {
    name: "skill_search",
    label: "Search Cyberful Skills",
    description:
      'Search available skill metadata by name, category, capability, trigger, tag, or security-framework identifier. Use query "*" to enumerate all skills, then call skill_read before applying one.',
    parameters: SkillSearchParameters,
    executionMode: "sequential",
    execute: async (_toolCallID, input) => {
      const query = input.query.trim()
      if (!query) throw new Error("skill_search query is empty")
      const candidates =
        query === "*"
          ? [...catalog]
          : catalog
              .flatMap((skill) => {
                const score = searchScore(skill, query)
                return score === undefined ? [] : [{ skill, score }]
              })
              .sort((left, right) => right.score - left.score || compareSkillNames(left.skill, right.skill))
              .map((candidate) => candidate.skill)
      const offset = input.cursor === undefined ? 0 : Number(input.cursor)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > candidates.length)
        throw new Error("skill_search cursor is invalid")
      const limit = input.limit ?? 8
      const page = candidates.slice(offset, offset + limit)
      const nextOffset = offset + page.length
      const nextCursor = nextOffset < candidates.length ? String(nextOffset) : undefined
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              query,
              total: candidates.length,
              results: page.map((skill) => ({
                name: skill.name,
                category: skill.category ?? "uncategorized",
                description: compactDescription(skill.description ?? ""),
                matched_terms: matchingTerms(skill, query),
              })),
              ...(nextCursor ? { next_cursor: nextCursor } : {}),
            }),
          },
        ],
        details: {
          query,
          total: candidates.length,
          returned: page.length,
          ...(nextCursor ? { nextCursor } : {}),
        },
      }
    },
  }
}

export async function discover(options: DiscoverSkillOptions): Promise<SkillRegistry> {
  const maxFileBytes = boundedFileSize(options.maxFileBytes)
  const roots = await Promise.all(options.roots.map(canonicalTrustedRoot))
  const discovered = await Promise.all(roots.map((root) => discoverPackages(root.path, root.origin, maxFileBytes)))
  const selected = new Map<string, SkillPackage>()
  for (const packages of discovered) for (const skill of packages) selected.set(skill.catalog.name, skill)
  const packages = [...selected.values()].toSorted((left, right) => compareText(left.catalog.name, right.catalog.name))
  const read = createReader(packages, maxFileBytes)
  const catalog = Object.freeze(packages.map((skill) => Object.freeze(skill.catalog)))
  const tool: SkillRegistry["tool"] = {
    name: "skill_read",
    label: "Read Cyberful Skill",
    description:
      "Read the complete SKILL.md for one available Cyberful skill, or an explicitly named file confined to that skill package. Read SKILL.md before applying a skill.",
    parameters: SkillReadParameters,
    execute: async (_toolCallID, request, signal) => read(request, signal),
  }

  return {
    catalog,
    tool,
    searchTool: createSearchTool(catalog),
    read,
  }
}

export * as PiSkills from "./pi-skills"
