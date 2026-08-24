#!/usr/bin/env bun
// ── Public Agent Skill Package Validation ───────────────────────
// Validates vendor-neutral skills separately from Cyberful's offensive embedded
// catalog so public packaging cannot change model-visible runtime capabilities.
// → skills/cyberful/SKILL.md — canonical cross-agent package.
// → cyberful/package.json — runs this validator during typecheck.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { lstat, readdir } from "node:fs/promises"
import matter from "gray-matter"

const repositoryRoot = path.resolve(import.meta.dir, "../..")
const skillsRoot = path.join(repositoryRoot, "skills")
const expectedSkills = ["cyberful"] as const
const expectedFiles = [
  "SKILL.md",
  "references/commands.md",
  "references/observability.md",
  "references/safety-and-control.md",
] as const

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Readonly<Record<string, unknown>>
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

async function regularFile(filename: string, label: string): Promise<void> {
  const metadata = await lstat(filename).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
}

async function validateFileTree(packageRoot: string): Promise<string[]> {
  const files: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`public skill packages must not contain symlinks: ${filename}`)
      if (entry.isDirectory()) await visit(filename)
      else if (entry.isFile()) files.push(path.relative(packageRoot, filename).split(path.sep).join("/"))
      else throw new Error(`public skill packages may contain only directories and regular files: ${filename}`)
    }
  }
  await visit(packageRoot)
  return files.toSorted()
}

async function validateLinks(packageRoot: string, filename: string, source: string): Promise<void> {
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1]?.trim()
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue
    const relativeTarget = target.split("#", 1)[0]
    if (!relativeTarget) continue
    const resolved = path.resolve(path.dirname(filename), relativeTarget)
    const relative = path.relative(packageRoot, resolved)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(`skill reference escapes its package: ${target}`)
    await regularFile(resolved, `skill reference '${target}'`)
  }
}

async function validateAdapters(skillName: string): Promise<void> {
  for (const root of [".agents", ".claude", ".codex"]) {
    const candidates = [
      path.join(repositoryRoot, root, "skills", skillName),
      path.join(repositoryRoot, root, "skill", skillName),
    ]
    for (const candidate of candidates) {
      const metadata = await lstat(candidate).catch(() => undefined)
      if (metadata)
        throw new Error(
          `${path.relative(repositoryRoot, candidate)} duplicates the canonical skills/${skillName} package; publish adapters only in reviewed platform packaging`,
        )
    }
  }
}

async function validateSkill(skillName: string): Promise<void> {
  const packageRoot = path.join(skillsRoot, skillName)
  const metadata = await lstat(packageRoot).catch(() => undefined)
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${skillName} must be a regular skill directory`)
  const files = await validateFileTree(packageRoot)
  if (files.join("\0") !== [...expectedFiles].toSorted().join("\0"))
    throw new Error(`${skillName} must contain exactly ${expectedFiles.join(", ")}`)

  const entry = path.join(packageRoot, "SKILL.md")
  const source = await Bun.file(entry).text()
  if (source.split(/\r?\n/).length > 500) throw new Error(`${skillName}/SKILL.md must remain below 500 lines`)
  const parsed = matter(source)
  const frontmatter = record(parsed.data, `${skillName} frontmatter`)
  if (text(frontmatter.name, `${skillName} name`) !== skillName) throw new Error(`${skillName} name must match its directory`)
  const description = text(frontmatter.description, `${skillName} description`)
  if (description.length > 1_024 || !description.includes("Cyberful"))
    throw new Error(`${skillName} description must identify Cyberful and remain below 1024 characters`)
  if (text(frontmatter.license, `${skillName} license`) !== "AGPL-3.0-only")
    throw new Error(`${skillName} license must be AGPL-3.0-only`)
  if (!text(frontmatter.compatibility, `${skillName} compatibility`).includes("0.4.0"))
    throw new Error(`${skillName} compatibility must require Cyberful 0.4.0 or later`)
  const skillMetadata = record(frontmatter.metadata, `${skillName} metadata`)
  if (text(skillMetadata.version, `${skillName} version`) !== "0.1.0")
    throw new Error(`${skillName} public package version must be 0.1.0`)
  if (text(skillMetadata.author, `${skillName} author`) !== "cyberful")
    throw new Error(`${skillName} author must be cyberful`)
  if (text(skillMetadata["cyberful-version"], `${skillName} Cyberful version`) !== ">=0.4.0")
    throw new Error(`${skillName} Cyberful compatibility metadata must be >=0.4.0`)

  let totalBytes = 0
  for (const relative of files) {
    const filename = path.join(packageRoot, relative)
    const markdown = await Bun.file(filename).text()
    totalBytes += Buffer.byteLength(markdown)
    await validateLinks(packageRoot, filename, markdown)
  }
  if (totalBytes > 100 * 1_024) throw new Error(`${skillName} package must remain below 100 KiB`)
  await validateAdapters(skillName)
}

const inventory = (await readdir(skillsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted()
if (inventory.join("\0") !== [...expectedSkills].join("\0"))
  throw new Error(`public skill inventory must contain exactly: ${expectedSkills.join(", ")}`)
for (const skillName of expectedSkills) await validateSkill(skillName)

console.log(`Validated ${expectedSkills.length} public Agent Skills package.`)
