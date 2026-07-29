// ── Pi Skill Boundary Tests ──────────────────────────────────────
// Protects explicit-only discovery, compact metadata, complete progressive
// reads, package confinement, symlink rejection, and bounded file access.
// → cyberful/src/subsystem/pi-skills.ts — owns the registry under test.
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as Builtin from "@/builtin"
import { PiSkills } from "./pi-skills"

const temporaryRoots: string[] = []

async function temporaryRoot(label: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), `cyberful-pi-skills-${label}-`)))
  temporaryRoots.push(root)
  return root
}

async function writeSkill(root: string, directory: string, metadata: readonly string[], body: string): Promise<string> {
  const packageRoot = path.join(root, directory)
  await mkdir(packageRoot, { recursive: true })
  const location = path.join(packageRoot, "SKILL.md")
  await writeFile(location, ["---", ...metadata, "---", "", body].join("\n"))
  return location
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("PiSkills", () => {
  test("catalogs the canonical built-in ZAP and Nuclei packages", async () => {
    const registry = await PiSkills.discover({ roots: [path.join(Builtin.DIR, "skills")] })

    expect(registry.catalog.find((skill) => skill.name === "ZAP")?.location).toBe(
      path.join(Builtin.DIR, "skills", "zap", "SKILL.md"),
    )
    expect(registry.catalog.find((skill) => skill.name === "NUCLEI")?.location).toBe(
      path.join(Builtin.DIR, "skills", "nuclei", "SKILL.md"),
    )
  })

  test("builds a deterministic compact catalog only from explicit trusted roots", async () => {
    const trusted = await temporaryRoot("catalog")
    await writeSkill(
      trusted,
      "zeta",
      [
        "name: zeta-analysis",
        "description: Analyze a bounded parser surface.",
        "keywords:",
        "  - parser",
        "  - grammar",
      ],
      "Keep complete evidence.",
    )
    await writeSkill(
      trusted,
      "alpha",
      ["name: alpha-recon", "description: Map an authorized surface.", "triggers:", "  - reconnaissance"],
      "Preserve the inventory.",
    )
    await writeSkill(
      trusted,
      ".pi/skills/ambient",
      ["name: ambient-policy", "description: Must never be discovered."],
      "Ambient instructions.",
    )

    const registry = await PiSkills.discover({ roots: [trusted] })

    expect(registry.catalog).toEqual([
      {
        name: "alpha-recon",
        description: "Map an authorized surface.",
        triggers: ["reconnaissance"],
        location: path.join(trusted, "alpha", "SKILL.md"),
      },
      {
        name: "zeta-analysis",
        description: "Analyze a bounded parser surface.",
        triggers: ["parser", "grammar"],
        location: path.join(trusted, "zeta", "SKILL.md"),
      },
    ])
    expect(registry.catalog.some((skill) => skill.name === "ambient-policy")).toBe(false)
  })

  test("reads complete instructions and explicit package resources by name or catalog path", async () => {
    const trusted = await temporaryRoot("reads")
    const instructions = [
      "---",
      "name: inspect-parser",
      "description: Inspect parser boundaries.",
      "---",
      "",
      "# Inspect Parser",
      "",
      "Read [the field guide](references/field-guide.md).",
    ].join("\n")
    const location = await writeSkill(
      trusted,
      "inspect-parser",
      ["name: inspect-parser", "description: Inspect parser boundaries."],
      ["# Inspect Parser", "", "Read [the field guide](references/field-guide.md)."].join("\n"),
    )
    await mkdir(path.join(trusted, "inspect-parser", "references"))
    await writeFile(path.join(trusted, "inspect-parser", "references", "field-guide.md"), "Complete reference.\n")
    const registry = await PiSkills.discover({ roots: [trusted] })

    const primary = await registry.tool.execute("skill-call", { skill: "inspect-parser" })
    const reference = await registry.read({
      skill: location,
      path: "references/field-guide.md",
    })

    expect(primary.content).toEqual([{ type: "text", text: instructions }])
    expect(primary.details).toMatchObject({
      skill: "inspect-parser",
      requestedPath: "SKILL.md",
      kind: "instructions",
    })
    expect(reference.content).toEqual([{ type: "text", text: "Complete reference.\n" }])
    expect(reference.details).toMatchObject({
      location: path.join(trusted, "inspect-parser", "references", "field-guide.md"),
      requestedPath: "references/field-guide.md",
      kind: "resource",
    })
  })

  test("never follows package or resource symlinks and rejects traversal", async () => {
    const trusted = await temporaryRoot("boundary")
    const outside = await temporaryRoot("outside")
    await writeSkill(
      trusted,
      "safe",
      ["name: safe-skill", "description: Stay inside the package."],
      "Read references/local.md.",
    )
    await mkdir(path.join(trusted, "safe", "references"))
    await writeFile(path.join(trusted, "safe", "references", "local.md"), "Local.\n")
    await writeFile(path.join(outside, "secret.md"), "Outside secret.\n")
    await symlink(path.join(outside, "secret.md"), path.join(trusted, "safe", "references", "linked.md"))
    await writeSkill(outside, "external", ["name: external-skill", "description: Must stay outside."], "Outside.")
    await symlink(path.join(outside, "external"), path.join(trusted, "linked-package"))
    const registry = await PiSkills.discover({ roots: [trusted] })

    expect(registry.catalog.map((skill) => skill.name)).toEqual(["safe-skill"])
    await expect(registry.read({ skill: "safe-skill", path: "../outside/secret.md" })).rejects.toThrow(
      "forbidden traversal",
    )
    await expect(registry.read({ skill: "safe-skill", path: path.join(outside, "secret.md") })).rejects.toThrow(
      "package-relative",
    )
    await expect(registry.read({ skill: "safe-skill", path: "references/linked.md" })).rejects.toThrow(
      "must not be a symbolic link",
    )
  })

  test("applies the configured byte bound to manifests and package resources", async () => {
    const trusted = await temporaryRoot("limit")
    await writeSkill(
      trusted,
      "bounded",
      ["name: bounded-skill", "description: Read bounded files."],
      "Short instructions.",
    )
    await mkdir(path.join(trusted, "bounded", "assets"))
    await writeFile(path.join(trusted, "bounded", "assets", "large.txt"), "x".repeat(257))

    const registry = await PiSkills.discover({ roots: [trusted], maxFileBytes: 256 })
    await expect(registry.read({ skill: "bounded-skill", path: "assets/large.txt" })).rejects.toThrow(
      "exceeds the 256-byte limit",
    )

    await writeFile(
      path.join(trusted, "bounded", "SKILL.md"),
      ["---", "name: bounded-skill", "description: Read bounded files.", "---", "", "x".repeat(300)].join("\n"),
    )
    await expect(PiSkills.discover({ roots: [trusted], maxFileBytes: 256 })).rejects.toThrow(
      "exceeds the 256-byte limit",
    )
  })

  test("uses later explicitly trusted roots as deterministic overrides", async () => {
    const first = await temporaryRoot("first")
    const override = await temporaryRoot("override")
    await writeSkill(
      first,
      "shared",
      ["name: shared-skill", "description: First-party version."],
      "First-party instructions.",
    )
    const overrideLocation = await writeSkill(
      override,
      "shared",
      ["name: shared-skill", "description: Trusted override."],
      "Override instructions.",
    )

    const registry = await PiSkills.discover({ roots: [first, override] })

    expect(registry.catalog).toEqual([
      {
        name: "shared-skill",
        description: "Trusted override.",
        location: overrideLocation,
      },
    ])
    expect((await registry.read({ skill: "shared-skill" })).content).toEqual([
      { type: "text", text: "---\nname: shared-skill\ndescription: Trusted override.\n---\n\nOverride instructions." },
    ])
  })
})
