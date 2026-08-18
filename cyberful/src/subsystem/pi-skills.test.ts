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
  test("catalogs the canonical built-in browser, ZAP, and Nuclei packages", async () => {
    const registry = await PiSkills.discover({ roots: [path.join(Builtin.DIR, "skills")] })

    expect(registry.catalog.find((skill) => skill.name === "operate-browser")?.location).toBe(
      path.join(Builtin.DIR, "skills", "operate-browser", "SKILL.md"),
    )
    expect(registry.catalog.find((skill) => skill.name === "operate-zap")?.location).toBe(
      path.join(Builtin.DIR, "skills", "operate-zap", "SKILL.md"),
    )
    expect(registry.catalog.find((skill) => skill.name === "operate-nuclei")?.location).toBe(
      path.join(Builtin.DIR, "skills", "operate-nuclei", "SKILL.md"),
    )
    expect(registry.catalog.find((skill) => skill.name === "test-authorization-boundaries")).toMatchObject({
      category: "authorization",
      triggers: expect.arrayContaining(["authorization boundary", "tenant isolation"]),
      searchTerms: expect.arrayContaining(["CWE-639", "T1078", "PR.AA"]),
    })
  })

  test("builds a deterministic compact catalog only from explicit trusted roots", async () => {
    const trusted = await temporaryRoot("catalog")
    await writeSkill(
      trusted,
      "analyze-zeta-parser",
      [
        "name: analyze-zeta-parser",
        "description: Analyze a bounded parser surface.",
        "keywords:",
        "  - parser",
        "  - grammar",
      ],
      "Keep complete evidence.",
    )
    await writeSkill(
      trusted,
      "plan-alpha-recon",
      ["name: plan-alpha-recon", "description: Map an authorized surface.", "triggers:", "  - reconnaissance"],
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
        name: "analyze-zeta-parser",
        description: "Analyze a bounded parser surface.",
        triggers: ["parser", "grammar"],
        origin: "first_party",
        category: "cyberful",
        searchTerms: ["parser", "grammar"],
        location: path.join(trusted, "analyze-zeta-parser", "SKILL.md"),
      },
      {
        name: "plan-alpha-recon",
        description: "Map an authorized surface.",
        triggers: ["reconnaissance"],
        origin: "first_party",
        category: "cyberful",
        searchTerms: ["reconnaissance"],
        location: path.join(trusted, "plan-alpha-recon", "SKILL.md"),
      },
    ])
    expect(registry.catalog.some((skill) => skill.name === "ambient-policy")).toBe(false)
  })

  test("requires the operational intent vocabulary only for first-party skill names", async () => {
    const firstParty = await temporaryRoot("first-party-name")
    const extension = await temporaryRoot("extension-name")
    await writeSkill(
      firstParty,
      "legacy-helper",
      ["name: legacy-helper", "description: Legacy first-party helper."],
      "Legacy instructions.",
    )
    await writeSkill(
      extension,
      "community-helper",
      ["name: community-helper", "description: Compatible extension helper."],
      "Extension instructions.",
    )

    await expect(PiSkills.discover({ roots: [{ path: firstParty, origin: "first_party" }] })).rejects.toThrow(
      /begin with one of: test-, audit-, trace-, analyze-, operate-, assess-, plan-/,
    )
    const registry = await PiSkills.discover({ roots: [{ path: extension, origin: "extension" }] })
    expect(registry.catalog.map((skill) => skill.name)).toEqual(["community-helper"])
  })

  test("reads complete instructions and explicit package resources by name or catalog path", async () => {
    const trusted = await temporaryRoot("reads")
    const instructions = [
      "---",
      "name: audit-parser",
      "description: Inspect parser boundaries.",
      "---",
      "",
      "# Inspect Parser",
      "",
      "Read [the field guide](references/field-guide.md).",
    ].join("\n")
    const location = await writeSkill(
      trusted,
      "audit-parser",
      ["name: audit-parser", "description: Inspect parser boundaries."],
      ["# Inspect Parser", "", "Read [the field guide](references/field-guide.md)."].join("\n"),
    )
    await mkdir(path.join(trusted, "audit-parser", "references"))
    await writeFile(path.join(trusted, "audit-parser", "references", "field-guide.md"), "Complete reference.\n")
    const registry = await PiSkills.discover({ roots: [trusted] })

    const primary = await registry.tool.execute("skill-call", { skill: "audit-parser" })
    const reference = await registry.read({
      skill: location,
      path: "references/field-guide.md",
    })

    expect(primary.content).toEqual([{ type: "text", text: instructions }])
    expect(primary.details).toMatchObject({
      skill: "audit-parser",
      requestedPath: "SKILL.md",
      kind: "instructions",
    })
    expect(reference.content).toEqual([{ type: "text", text: "Complete reference.\n" }])
    expect(reference.details).toMatchObject({
      location: path.join(trusted, "audit-parser", "references", "field-guide.md"),
      requestedPath: "references/field-guide.md",
      kind: "resource",
    })
  })

  test("never follows package or resource symlinks and rejects traversal", async () => {
    const trusted = await temporaryRoot("boundary")
    const outside = await temporaryRoot("outside")
    await writeSkill(
      trusted,
      "audit-safe-package",
      ["name: audit-safe-package", "description: Stay inside the package."],
      "Read references/local.md.",
    )
    await mkdir(path.join(trusted, "audit-safe-package", "references"))
    await writeFile(path.join(trusted, "audit-safe-package", "references", "local.md"), "Local.\n")
    await writeFile(path.join(outside, "secret.md"), "Outside secret.\n")
    await symlink(path.join(outside, "secret.md"), path.join(trusted, "audit-safe-package", "references", "linked.md"))
    await writeSkill(outside, "external", ["name: external-skill", "description: Must stay outside."], "Outside.")
    await symlink(path.join(outside, "external"), path.join(trusted, "linked-package"))
    const registry = await PiSkills.discover({ roots: [trusted] })

    expect(registry.catalog.map((skill) => skill.name)).toEqual(["audit-safe-package"])
    await expect(registry.read({ skill: "audit-safe-package", path: "../outside/secret.md" })).rejects.toThrow(
      "forbidden traversal",
    )
    await expect(registry.read({ skill: "audit-safe-package", path: path.join(outside, "secret.md") })).rejects.toThrow(
      "package-relative",
    )
    await expect(registry.read({ skill: "audit-safe-package", path: "references/linked.md" })).rejects.toThrow(
      "must not be a symbolic link",
    )
  })

  test("applies the configured byte bound to manifests and package resources", async () => {
    const trusted = await temporaryRoot("limit")
    await writeSkill(
      trusted,
      "analyze-bounded-resource",
      ["name: analyze-bounded-resource", "description: Read bounded files."],
      "Short instructions.",
    )
    await mkdir(path.join(trusted, "analyze-bounded-resource", "assets"))
    await writeFile(path.join(trusted, "analyze-bounded-resource", "assets", "large.txt"), "x".repeat(257))

    const registry = await PiSkills.discover({ roots: [trusted], maxFileBytes: 256 })
    await expect(registry.read({ skill: "analyze-bounded-resource", path: "assets/large.txt" })).rejects.toThrow(
      "exceeds the 256-byte limit",
    )

    await writeFile(
      path.join(trusted, "analyze-bounded-resource", "SKILL.md"),
      ["---", "name: analyze-bounded-resource", "description: Read bounded files.", "---", "", "x".repeat(300)].join(
        "\n",
      ),
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
      "assess-shared-skill",
      ["name: assess-shared-skill", "description: First-party version."],
      "First-party instructions.",
    )
    const overrideLocation = await writeSkill(
      override,
      "assess-shared-skill",
      ["name: assess-shared-skill", "description: Trusted override."],
      "Override instructions.",
    )

    const registry = await PiSkills.discover({
      roots: [
        { path: first, origin: "first_party" },
        { path: override, origin: "extension" },
      ],
    })

    expect(registry.catalog).toEqual([
      {
        name: "assess-shared-skill",
        description: "Trusted override.",
        origin: "extension",
        category: "uncategorized",
        location: overrideLocation,
      },
    ])
    expect((await registry.read({ skill: "assess-shared-skill" })).content).toEqual([
      {
        type: "text",
        text: "---\nname: assess-shared-skill\ndescription: Trusted override.\n---\n\nOverride instructions.",
      },
    ])
  })

  test("searches indexed metadata deterministically without exposing paths or reading instructions", async () => {
    const trusted = await temporaryRoot("search")
    await writeSkill(
      trusted,
      "sql",
      [
        "name: sql-injection",
        "description: Test query parameters for database injection while preserving reproducible evidence.",
        "domain: application-security",
        "subdomain: web-injection",
        "triggers:",
        "  - injection",
        "tags:",
        "  - database",
        "mitre_attack:",
        "  - T1190",
      ],
      "Complete SQL injection instructions.",
    )
    await writeSkill(
      trusted,
      "cloud",
      [
        "name: cloud-audit",
        "description: Review cloud identity boundaries and configuration evidence.",
        "domain: cloud-security",
        "tags:",
        "  - aws",
        "nist_csf:",
        "  - PR.AA",
      ],
      "Complete cloud audit instructions.",
    )
    const registry = await PiSkills.discover({
      roots: [{ path: trusted, origin: "extension" }],
    })
    const search = async (query: string, limit?: number, cursor?: string) => {
      const result = await registry.searchTool.execute("search", {
        query,
        ...(limit ? { limit } : {}),
        ...(cursor ? { cursor } : {}),
      })
      const content = result.content[0]
      if (!content || content.type !== "text") throw new Error("skill_search did not return text")
      return JSON.parse(content.text) as {
        total: number
        results: readonly { name: string; category: string; description: string; matched_terms: readonly string[] }[]
        next_cursor?: string
      }
    }

    expect((await search("sql-injection")).results[0]?.name).toBe("sql-injection")
    expect((await search("sql")).results[0]?.name).toBe("sql-injection")
    expect((await search("web-injection")).results[0]?.category).toBe("web-injection")
    expect((await search("database")).results[0]?.matched_terms).toContain("database")
    expect((await search("T1190")).results[0]?.matched_terms).toContain("T1190")
    expect((await search("query parameter")).results[0]?.name).toBe("sql-injection")
    expect((await search("PR.AA")).results[0]?.name).toBe("cloud-audit")

    const first = await search("*", 1)
    const second = await search("*", 1, first.next_cursor)
    expect(first.results.map((item) => item.name)).toEqual(["cloud-audit"])
    expect(second.results.map((item) => item.name)).toEqual(["sql-injection"])
    expect(JSON.stringify(first)).not.toContain(trusted)
    await expect(registry.searchTool.execute("search", { query: "*", cursor: "999" })).rejects.toThrow(
      "cursor is invalid",
    )
    await expect(registry.read({ skill: "missing" })).rejects.toThrow("use skill_search")
  })
})
