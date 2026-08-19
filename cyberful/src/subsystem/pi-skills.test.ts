// ── Pi Skill Boundary Tests ──────────────────────────────────────
// Protects explicit-only discovery, compact metadata, complete progressive
// reads, package confinement, symlink rejection, and bounded file access.
// → cyberful/src/subsystem/pi-skills.ts — owns the registry under test.
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
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
      searchTerms: expect.arrayContaining(["MITRE ATT&CK", "T1078", "NIST CSF", "PR.AA-05"]),
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
    const workarea = await temporaryRoot("boundary-workarea")
    await writeSkill(
      trusted,
      "audit-safe-package",
      ["name: audit-safe-package", "description: Stay inside the package."],
      "Read references/local.md.",
    )
    await mkdir(path.join(trusted, "audit-safe-package", "references"))
    await mkdir(path.join(trusted, "audit-safe-package", "assets"))
    await writeFile(path.join(trusted, "audit-safe-package", "references", "local.md"), "Local.\n")
    await writeFile(path.join(outside, "secret.md"), "Outside secret.\n")
    await symlink(path.join(outside, "secret.md"), path.join(trusted, "audit-safe-package", "references", "linked.md"))
    await symlink(path.join(outside, "secret.md"), path.join(trusted, "audit-safe-package", "assets", "linked.md"))
    await writeSkill(outside, "external", ["name: external-skill", "description: Must stay outside."], "Outside.")
    await symlink(path.join(outside, "external"), path.join(trusted, "linked-package"))
    const registry = await PiSkills.discover({ roots: [trusted], stagingRoot: workarea })

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
    const stageError = await registry.stageTool
      .execute("stage-linked", { skill: "audit-safe-package", path: "assets/linked.md" })
      .then(
        () => "",
        (error) => (error instanceof Error ? error.message : String(error)),
      )
    expect(stageError).toContain("must not be a symbolic link")
    expect(stageError).not.toContain(trusted)
    expect(stageError).not.toContain(outside)
  })

  test("applies the configured byte bound to manifests and package resources", async () => {
    const trusted = await temporaryRoot("limit")
    const workarea = await temporaryRoot("limit-workarea")
    await writeSkill(
      trusted,
      "analyze-bounded-resource",
      ["name: analyze-bounded-resource", "description: Read bounded files."],
      "Short instructions.",
    )
    await mkdir(path.join(trusted, "analyze-bounded-resource", "assets"))
    await writeFile(path.join(trusted, "analyze-bounded-resource", "assets", "large.txt"), "x".repeat(257))

    const registry = await PiSkills.discover({ roots: [trusted], maxFileBytes: 256, stagingRoot: workarea })
    await expect(registry.read({ skill: "analyze-bounded-resource", path: "assets/large.txt" })).rejects.toThrow(
      "exceeds the 256-byte limit",
    )
    const stageError = await registry.stageTool
      .execute("stage-large", { skill: "analyze-bounded-resource", path: "assets/large.txt" })
      .then(
        () => "",
        (error) => (error instanceof Error ? error.message : String(error)),
      )
    expect(stageError).toContain("exceeds the 256-byte limit")
    expect(stageError).not.toContain(trusted)

    await writeSkill(
      trusted,
      "analyze-bounded-package",
      ["name: analyze-bounded-package", "description: Bound the complete package snapshot before staging."],
      "Keep the complete snapshot bounded.",
    )
    const boundedAssets = path.join(trusted, "analyze-bounded-package", "assets")
    await mkdir(boundedAssets)
    await Promise.all(
      Array.from({ length: 17 }, (_, index) =>
        writeFile(path.join(boundedAssets, `${index}.bin`), Buffer.alloc(256, index)),
      ),
    )
    const boundedRegistry = await PiSkills.discover({ roots: [trusted], maxFileBytes: 256, stagingRoot: workarea })
    await expect(
      boundedRegistry.stageTool.execute("stage-package-limit", {
        skill: "analyze-bounded-package",
        path: "assets/0.bin",
      }),
    ).rejects.toThrow("4096-byte staging limit")

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

  test("stages reviewed scripts and assets atomically under a content-addressed workarea path", async () => {
    const trusted = await temporaryRoot("stage-package")
    const workarea = await temporaryRoot("stage-workarea")
    await writeSkill(
      trusted,
      "operate-stage-fixture",
      ["name: operate-stage-fixture", "description: Stage a bounded package resource."],
      "Stage scripts only after reading these complete instructions.",
    )
    await mkdir(path.join(trusted, "operate-stage-fixture", "scripts"))
    await mkdir(path.join(trusted, "operate-stage-fixture", "assets"))
    await writeFile(path.join(trusted, "operate-stage-fixture", "scripts", "campaign.py"), "print('raw')\n")
    await writeFile(path.join(trusted, "operate-stage-fixture", "scripts", "manifest.json"), '{"version":1}\n')
    await writeFile(path.join(trusted, "operate-stage-fixture", "assets", "schema.json"), '{"type":"object"}\n')
    const registry = await PiSkills.discover({ roots: [trusted], stagingRoot: workarea })

    const cancelled = new AbortController()
    cancelled.abort(new Error("cancel staging"))
    await expect(
      registry.stageTool.execute(
        "stage-cancelled",
        { skill: "operate-stage-fixture", path: "scripts/campaign.py" },
        cancelled.signal,
      ),
    ).rejects.toThrow("cancel staging")
    const first = await registry.stageTool.execute("stage-1", {
      skill: "operate-stage-fixture",
      path: "scripts/campaign.py",
    })
    const second = await registry.stageTool.execute("stage-2", {
      skill: "operate-stage-fixture",
      path: "scripts/campaign.py",
    })
    expect(first.details).toEqual(second.details)
    expect(Object.keys(first.details).toSorted()).toEqual(["bytes", "path", "sha256"])
    expect(first.details.path).toMatch(
      /^raw\/skill-resources\/operate-stage-fixture\/[a-f0-9]{64}\/scripts\/campaign\.py$/,
    )
    expect(JSON.stringify(first)).not.toContain(trusted)
    const stagedScript = path.join(workarea, first.details.path)
    expect(await readFile(stagedScript, "utf8")).toBe("print('raw')\n")
    expect((await stat(stagedScript)).mode & 0o777).toBe(0o700)

    const scriptManifest = await registry.stageTool.execute("stage-manifest", {
      skill: "operate-stage-fixture",
      path: "scripts/manifest.json",
    })
    expect((await stat(path.join(workarea, scriptManifest.details.path))).mode & 0o777).toBe(0o600)

    const asset = await registry.stageTool.execute("stage-asset", {
      skill: "operate-stage-fixture",
      path: "assets/schema.json",
    })
    expect(asset.details.path.split("/").at(3)).toBe(first.details.path.split("/").at(3))
    expect((await stat(path.join(workarea, asset.details.path))).mode & 0o777).toBe(0o600)
    await expect(
      registry.stageTool.execute("stage-reference", {
        skill: "operate-stage-fixture",
        path: "references/field-guide.md",
      }),
    ).rejects.toThrow("below scripts/ or assets/")
    await expect(
      registry.stageTool.execute("stage-traversal", {
        skill: "operate-stage-fixture",
        path: "scripts/../SKILL.md",
      }),
    ).rejects.toThrow("forbidden traversal")
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

  test("keeps all 106 built-in skills reachable through the complete progressive search index", async () => {
    const registry = await PiSkills.discover({ roots: [path.join(Builtin.DIR, "skills")] })
    type SearchItem = {
      readonly name: string
      readonly category: string
      readonly description: string
      readonly matched_terms: readonly string[]
    }
    type SearchPage = {
      readonly total: number
      readonly results: readonly SearchItem[]
      readonly next_cursor?: string
    }
    const page = async (query: string, cursor?: string): Promise<SearchPage> => {
      const result = await registry.searchTool.execute(`search-${query}-${cursor ?? "first"}`, {
        query,
        limit: 20,
        ...(cursor === undefined ? {} : { cursor }),
      })
      const content = result.content[0]
      if (!content || content.type !== "text") throw new Error("skill_search did not return text")
      expect(content.text).not.toContain(Builtin.DIR)
      return JSON.parse(content.text) as SearchPage
    }
    const allResults = async (query: string): Promise<readonly SearchItem[]> => {
      const results: SearchItem[] = []
      let cursor: string | undefined
      do {
        const current = await page(query, cursor)
        results.push(...current.results)
        cursor = current.next_cursor
      } while (cursor !== undefined)
      return results
    }
    const names = registry.catalog.map((skill) => skill.name)

    expect(names).toHaveLength(106)
    expect(new Set(names).size).toBe(106)
    for (const skill of registry.catalog) {
      expect((await page(skill.name)).results[0]?.name).toBe(skill.name)

      const uniquePrefix = Array.from({ length: skill.name.length - 1 }, (_, index) => skill.name.slice(0, index + 1)).find(
        (prefix) => names.filter((name) => name.startsWith(prefix)).length === 1,
      )
      if (uniquePrefix) expect((await page(uniquePrefix)).results[0]?.name).toBe(skill.name)
      else expect((await allResults(skill.name.slice(0, -1))).map((result) => result.name)).toContain(skill.name)

      const canonicalTrigger = skill.triggers?.[0]
      expect(canonicalTrigger).toBeDefined()
      expect((await page(canonicalTrigger ?? "")).results.map((result) => result.name)).toContain(skill.name)
      expect((await allResults(skill.category ?? "uncategorized")).map((result) => result.name)).toContain(skill.name)

      const tag = skill.searchTerms?.find(
        (term) =>
          !(skill.triggers ?? []).includes(term) &&
          !/^(?:MITRE ATT&CK|NIST CSF|MITRE ATLAS|MITRE D3FEND|NIST AI RMF|MITRE F3|PCI DSS|GDPR)$/.test(term) &&
          !/^(?:T\d{4}(?:\.\d{3})?|AML\.(?:TA|T|M)\d{4}(?:\.\d{3})?|D3-[A-Z0-9-]+|F\d{4}(?:\.\d{3})?|(?:GV|ID|PR|DE|RS|RC)\.[A-Z]{2}(?:-\d{2})?|(?:GOVERN|MAP|MEASURE|MANAGE)(?:[ .-]\d+(?:\.\d+)?)?|\d+(?:\.\d+){2,3}|Article (?:[1-9]|[1-9]\d)(?:\(\d+\))?)$/.test(
            term,
          ),
      )
      expect(tag).toBeDefined()
      expect((await allResults(tag ?? "")).map((result) => result.name)).toContain(skill.name)
    }

    const frameworkLabels = [
      "MITRE ATT&CK",
      "NIST CSF",
      "MITRE ATLAS",
      "MITRE D3FEND",
      "NIST AI RMF",
      "MITRE F3",
      "PCI DSS",
      "GDPR",
    ] as const
    for (const framework of frameworkLabels) expect((await allResults(framework)).length).toBeGreaterThan(0)

    const identifiers = new Set(
      registry.catalog.flatMap((skill) =>
        (skill.searchTerms ?? []).filter((term) =>
          /^(?:T\d{4}(?:\.\d{3})?|AML\.(?:TA|T|M)\d{4}(?:\.\d{3})?|D3-[A-Z0-9-]+|F\d{4}(?:\.\d{3})?|(?:GV|ID|PR|DE|RS|RC)\.[A-Z]{2}(?:-\d{2})?|(?:GOVERN|MAP|MEASURE|MANAGE)(?:[ .-]\d+(?:\.\d+)?)?|\d+(?:\.\d+){2,3}|Article (?:[1-9]|[1-9]\d)(?:\(\d+\))?)$/.test(
            term,
          ),
        ),
      ),
    )
    for (const identifier of identifiers) {
      const expected = registry.catalog
        .filter((skill) => skill.searchTerms?.includes(identifier))
        .map((skill) => skill.name)
      const found = (await allResults(identifier)).map((result) => result.name)
      for (const name of expected) expect(found).toContain(name)
    }

    const wildcard = await allResults("*")
    expect(wildcard.map((result) => result.name)).toEqual(names)
    expect(new Set(wildcard.map((result) => result.name)).size).toBe(106)
  })
})
