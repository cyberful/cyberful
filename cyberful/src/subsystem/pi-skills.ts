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

const DEFAULT_MAX_FILE_BYTES = 512 * 1024
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

export interface DiscoverSkillOptions {
  readonly roots: readonly string[]
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

export interface SkillRegistry {
  readonly catalog: readonly PromptSkill[]
  readonly tool: AgentTool<typeof SkillReadParameters, SkillReadDetails>
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

function triggerList(value: unknown, label: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`${label} must be an array of strings`)
  return value.map((item) => item.trim()).filter(Boolean)
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
  const triggers = [
    ...triggerList(parsed.data.triggers, `skill '${name}' triggers`),
    ...triggerList(parsed.data.keywords, `skill '${name}' keywords`),
  ]
  return { name, description, triggers: [...new Set(triggers)] }
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

async function canonicalTrustedRoot(root: string): Promise<string> {
  const requested = path.resolve(required(root, "Pi skill root"))
  if (containsAmbientDirectory(requested))
    throw new Error(`Pi skill root '${requested}' is an ambient agent configuration directory`)
  const metadata = await lstat(requested)
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error(`Pi skill root '${requested}' must be a non-symlink directory`)
  return realpath(requested)
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
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<readonly SkillPackage[]> {
  const packages: SkillPackage[] = []

  const visit = async (directory: string): Promise<void> => {
    abortIfRequested(signal)
    const entries = (await readdir(directory, { withFileTypes: true })).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )
    const manifest = entries.find((entry) => entry.name === "SKILL.md")
    if (manifest) {
      const location = path.join(directory, manifest.name)
      const metadata = await lstat(location)
      if (!metadata.isSymbolicLink() && metadata.isFile()) {
        const source = decodeText(await readRegularFile(location, maxFileBytes, signal), location)
        const parsed = parseMetadata(source, location)
        packages.push({
          catalog: {
            name: parsed.name,
            description: parsed.description,
            ...(parsed.triggers.length > 0 ? { triggers: parsed.triggers } : {}),
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
    if (!skill)
      throw new Error(
        `Pi skill '${locator}' is not available; choose one of: ${[...byName.keys()].toSorted().join(", ") || "none"}`,
      )
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

export async function discover(options: DiscoverSkillOptions): Promise<SkillRegistry> {
  const maxFileBytes = boundedFileSize(options.maxFileBytes)
  const roots = await Promise.all(options.roots.map(canonicalTrustedRoot))
  const discovered = await Promise.all(roots.map((root) => discoverPackages(root, maxFileBytes)))
  const selected = new Map<string, SkillPackage>()
  for (const packages of discovered) for (const skill of packages) selected.set(skill.catalog.name, skill)
  const packages = [...selected.values()].toSorted((left, right) => left.catalog.name.localeCompare(right.catalog.name))
  const read = createReader(packages, maxFileBytes)
  const tool: SkillRegistry["tool"] = {
    name: "skill_read",
    label: "Read Cyberful Skill",
    description:
      "Read the complete SKILL.md for one available Cyberful skill, or an explicitly named file confined to that skill package. Read SKILL.md before applying a skill.",
    parameters: SkillReadParameters,
    execute: async (_toolCallID, request, signal) => read(request, signal),
  }

  return {
    catalog: Object.freeze(packages.map((skill) => Object.freeze(skill.catalog))),
    tool,
    read,
  }
}

export * as PiSkills from "./pi-skills"
