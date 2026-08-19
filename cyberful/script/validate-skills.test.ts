// ── Built-in Skill Validator Boundary Tests ─────────────────────
// Copies one real package into an isolated root and proves the shared gate
// rejects transport self-selection, traversal, malformed schemas, and examples.
// → cyberful/script/validate-skills.ts — production validator under test.
// → cyberful/builtin/skills/test-service-workload-identity — valid source fixture.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { validateSkillPackages } from "./validate-skills"

const fixtureName = "test-service-workload-identity"
const builtInRoot = path.resolve(import.meta.dir, "../builtin/skills")
const temporaryRoots: string[] = []

async function isolatedRoot(): Promise<string> {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "cyberful-skill-validator-"))
  temporaryRoots.push(root)
  await cp(path.join(builtInRoot, "framework-sources.json"), path.join(root, "framework-sources.json"))
  await cp(path.join(builtInRoot, "framework-identifiers.json"), path.join(root, "framework-identifiers.json"))
  await cp(path.join(builtInRoot, fixtureName), path.join(root, fixtureName), { recursive: true })
  return root
}

async function manifest(root: string): Promise<Record<string, unknown>> {
  return Bun.file(path.join(root, fixtureName, "scripts/manifest.json")).json()
}

async function replaceManifest(root: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(root, fixtureName, "scripts/manifest.json"), `${JSON.stringify(value, null, 2)}\n`)
}

describe("built-in skill validator boundaries", () => {
  beforeEach(() => {
    temporaryRoots.length = 0
  })

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  test("accepts a real package with runtime-owned target transport", async () => {
    const root = await isolatedRoot()
    await expect(validateSkillPackages([fixtureName], root)).resolves.toBeUndefined()
  })

  test("rejects missing target transport and transport declared as a secret", async () => {
    const root = await isolatedRoot()
    const missing = await manifest(root)
    delete missing.transport
    await replaceManifest(root, missing)
    await expect(validateSkillPackages([fixtureName], root)).rejects.toThrow("target transport")

    const declared = await manifest(await isolatedRoot())
    const secrets = declared.secrets as { environment: string[] }
    secrets.environment.push("HTTP_PROXY")
    const declaredRoot = temporaryRoots.at(-1)!
    await replaceManifest(declaredRoot, declared)
    await expect(validateSkillPackages([fixtureName], declaredRoot)).rejects.toThrow("instead of declaring it as a skill secret")
  })

  test("rejects traversing schema paths and model-selected transport fields", async () => {
    const traversalRoot = await isolatedRoot()
    const traversal = await manifest(traversalRoot)
    ;(traversal.input as { schema: string }).schema = "assets/../../framework-sources.json"
    await replaceManifest(traversalRoot, traversal)
    await expect(validateSkillPackages([fixtureName], traversalRoot)).rejects.toThrow("traversal")

    const fieldRoot = await isolatedRoot()
    const schemaFile = path.join(fieldRoot, fixtureName, "assets/workload-identity-probe.schema.json")
    const schema = await Bun.file(schemaFile).json()
    schema.properties.proxy_origin = { type: "string" }
    await writeFile(schemaFile, `${JSON.stringify(schema, null, 2)}\n`)
    await expect(validateSkillPackages([fixtureName], fieldRoot)).rejects.toThrow("model-selected transport field")
  })

  test("compiles every schema and validates the packaged input example", async () => {
    const schemaRoot = await isolatedRoot()
    const schemaFile = path.join(schemaRoot, fixtureName, "assets/workload-identity-evidence.schema.json")
    await writeFile(schemaFile, '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"not-a-type"}\n')
    await expect(validateSkillPackages([fixtureName], schemaRoot)).rejects.toThrow("not a valid draft 2020-12 JSON Schema")

    const exampleRoot = await isolatedRoot()
    const exampleFile = path.join(exampleRoot, fixtureName, "assets/workload-identity-probe.example.json")
    await writeFile(exampleFile, "{}\n")
    await expect(validateSkillPackages([fixtureName], exampleRoot)).rejects.toThrow("input example violates its schema")
  })

  test("rejects symlinked schema parents", async () => {
    if (process.platform === "win32") return
    const root = await isolatedRoot()
    const packageRoot = path.join(root, fixtureName)
    const outside = path.join(root, "outside")
    await mkdir(outside)
    await cp(path.join(packageRoot, "assets/workload-identity-probe.schema.json"), path.join(outside, "schema.json"))
    await rm(path.join(packageRoot, "assets"), { recursive: true })
    await symlink(outside, path.join(packageRoot, "assets"), "dir")
    await expect(validateSkillPackages([fixtureName], root)).rejects.toThrow("symbolic links")
  })

  test("binds every mapping to a reviewed identifier from the pinned source digest", async () => {
    const mappingRoot = await isolatedRoot()
    const skillFile = path.join(mappingRoot, fixtureName, "SKILL.md")
    const skillSource = await Bun.file(skillFile).text()
    await writeFile(skillFile, skillSource.replace("PR.AA-05", "PR.AA-99"))
    await expect(validateSkillPackages([fixtureName], mappingRoot)).rejects.toThrow("not in the reviewed nist_csf snapshot index")

    const digestRoot = await isolatedRoot()
    const indexFile = path.join(digestRoot, "framework-identifiers.json")
    const index = await Bun.file(indexFile).json()
    index.frameworks.nist_csf.source_sha256 = "0".repeat(64)
    await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`)
    await expect(validateSkillPackages([fixtureName], digestRoot)).rejects.toThrow(
      "source SHA-256 does not match framework-sources.json",
    )
  })
})
