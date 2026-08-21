// ── Offline MITRE ATT&CK Snapshot And MCP Tests ──────────────────
// Exercises build resolution, STIX validation, deterministic local queries,
// embedded restoration, and the one-tool MCP contract without network access.
// → cyberful/src/mitre-attack/builder.ts — builds the fixture snapshot.
// → cyberful/src/subsystem/mitre-attack/server.ts — publishes the tested tool.
// ─────────────────────────────────────────────────────────────────

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { AnySchema } from "ajv"
import Ajv2020 from "ajv/dist/2020"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { materializeEmbeddedSnapshot } from "../bootstrap-mitre-attack"
import {
  ATTACK_INDEX_URL,
  ATTACK_LICENSE_URL,
  buildAttackSnapshot,
  embeddedAttackSnapshot,
  resolveAttackIndex,
  validateAttackRoutingIdentifiers,
} from "./builder"
import { AttackStore } from "./store"
import type { AttackDomain, AttackSnapshotManifest } from "./types"
import { parseAttackAssessment } from "./assessment"
import { ATTACK_RUNTIME_DIR_ENV } from "./runtime"
import { createMitreAttackServer } from "../subsystem/mitre-attack/server"

const sourceUrls = {
  enterprise:
    "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/enterprise-attack/enterprise-attack-19.2.json",
  mobile:
    "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/mobile-attack/mobile-attack-19.2.json",
  ics: "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/ics-attack/ics-attack-19.2.json",
} satisfies Record<AttackDomain, string>

function attackObject(
  domain: AttackDomain,
  type: string,
  id: string,
  name: string,
  attackID: string,
  url: string,
  extra: Record<string, unknown> = {},
) {
  return {
    type,
    spec_version: "2.1",
    id,
    name,
    x_mitre_domains: [`${domain}-attack`],
    external_references: [{ source_name: `mitre-${domain}-attack`, external_id: attackID, url }],
    ...extra,
  }
}

function bundle(domain: AttackDomain) {
  const tactic = attackObject(
    domain,
    "x-mitre-tactic",
    "x-mitre-tactic--initial-access",
    "Initial Access",
    "TA0001",
    "https://attack.mitre.org/tactics/TA0001/",
    { x_mitre_shortname: "initial-access" },
  )
  const technique = attackObject(
    domain,
    "attack-pattern",
    "attack-pattern--valid-accounts",
    "Valid Accounts",
    "T1078",
    "https://attack.mitre.org/techniques/T1078/",
    {
      description: "Adversaries may obtain and abuse credentials of existing accounts.",
      aliases: ["Credential abuse"],
      x_mitre_platforms:
        domain === "enterprise" ? ["Windows", "Linux"] : domain === "mobile" ? ["Android"] : ["Control Server"],
      kill_chain_phases: [{ kill_chain_name: `mitre-${domain}-attack`, phase_name: "initial-access" }],
    },
  )
  const subtechnique = attackObject(
    domain,
    "attack-pattern",
    "attack-pattern--cloud-accounts",
    "Cloud Accounts",
    "T1078.004",
    "https://attack.mitre.org/techniques/T1078/004/",
    {
      description: "Adversaries may obtain and abuse cloud accounts.",
      x_mitre_is_subtechnique: true,
      x_mitre_platforms: ["Identity Provider"],
      kill_chain_phases: [{ kill_chain_name: `mitre-${domain}-attack`, phase_name: "initial-access" }],
    },
  )
  const deprecated = attackObject(
    domain,
    "attack-pattern",
    "attack-pattern--legacy",
    "Legacy Technique",
    "T1999",
    "https://attack.mitre.org/techniques/T1999/",
    { x_mitre_deprecated: true, kill_chain_phases: [{ phase_name: "initial-access" }] },
  )
  const software = attackObject(
    domain,
    "malware",
    "malware--fixture",
    "Fixture Malware",
    "S0001",
    "https://attack.mitre.org/software/S0001/",
    { description: "Fixture software." },
  )
  const group = attackObject(
    domain,
    "intrusion-set",
    "intrusion-set--fixture",
    "Fixture Group",
    "G0001",
    "https://attack.mitre.org/groups/G0001/",
    { aliases: ["Fixture Alias"] },
  )
  return {
    type: "bundle",
    id: `bundle--${domain}`,
    objects: [
      tactic,
      technique,
      subtechnique,
      deprecated,
      software,
      group,
      {
        type: "relationship",
        spec_version: "2.1",
        id: "relationship--group-software",
        relationship_type: "uses",
        source_ref: group.id,
        target_ref: software.id,
        description: "The group uses the fixture software.",
      },
      {
        type: "relationship",
        spec_version: "2.1",
        id: "relationship--software-technique",
        relationship_type: "uses",
        source_ref: software.id,
        target_ref: technique.id,
        description: "The software uses valid accounts.",
      },
      {
        type: "relationship",
        spec_version: "2.1",
        id: "relationship--revoked-group-technique",
        relationship_type: "uses",
        source_ref: group.id,
        target_ref: deprecated.id,
        description: "A revoked fixture relationship.",
        revoked: true,
      },
      {
        type: "x-mitre-matrix",
        spec_version: "2.1",
        id: "x-mitre-matrix--fixture",
        name: `${domain} fixture matrix`,
        tactic_refs: [tactic.id],
      },
    ],
  }
}

const index = {
  modified: "2026-08-18T00:00:00Z",
  collections: (["enterprise", "mobile", "ics"] as const).map((domain) => ({
    id: `collection--${domain}`,
    name: domain === "enterprise" ? "Enterprise ATT&CK" : domain === "mobile" ? "Mobile ATT&CK" : "ICS ATT&CK",
    versions: [
      { version: "19.2", url: sourceUrls[domain], modified: "2026-08-18T00:00:00Z" },
      {
        version: "19.1",
        url: sourceUrls[domain].replaceAll("19.2", "19.1"),
        modified: "2026-07-01T00:00:00Z",
      },
    ],
  })),
}

describe("MITRE ATT&CK build snapshot", () => {
  let root: string
  let output: string
  let manifest: AttackSnapshotManifest
  const calls: string[] = []

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-attack-test-"))
    output = path.join(root, "snapshot")
    const bytes = new Map<string, Buffer>([
      [ATTACK_INDEX_URL, Buffer.from(JSON.stringify(index))],
      [ATTACK_LICENSE_URL, Buffer.from("The MITRE Corporation grants a royalty-free license.\n")],
      ...Object.entries(sourceUrls).map(
        ([domain, url]) => [url, Buffer.from(JSON.stringify(bundle(domain as AttackDomain)))] as const,
      ),
    ])
    manifest = await buildAttackSnapshot({
      outputDir: output,
      cyberfulVersion: "1.2.3",
      buildID: "fixture-build",
      now: () => new Date("2026-08-20T00:00:00Z"),
      fetchBytes: async (url) => {
        calls.push(url)
        const value = bytes.get(url)
        if (!value) throw new Error(`unexpected fixture URL ${url}`)
        return value
      },
    })
  })

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  test("resolves latest once and emits a verified three-domain snapshot", () => {
    expect(resolveAttackIndex(index).domains.map((item) => item.version.version)).toEqual(["19.2", "19.2", "19.2"])
    expect(calls.filter((url) => url === ATTACK_INDEX_URL)).toHaveLength(1)
    expect(new Set(calls)).toEqual(new Set([ATTACK_INDEX_URL, ATTACK_LICENSE_URL, ...Object.values(sourceUrls)]))
    expect(manifest.domains.map((item) => [item.domain, item.version])).toEqual([
      ["enterprise", "19.2"],
      ["mobile", "19.2"],
      ["ics", "19.2"],
    ])
    expect(() => embeddedAttackSnapshot(output)).not.toThrow()
    expect(fs.readFileSync(path.join(output, "SHA256SUMS"), "utf8")).toContain("SBOM.spdx.json")
  })

  test("queries IDs, filters, pagination, relationships, and matrices deterministically", () => {
    const store = new AttackStore(path.join(output, manifest.database.file), manifest)
    try {
      const first = store.search({ query: "Accounts", domains: ["enterprise"], limit: 1 })
      expect(first.items[0]).toMatchObject({ snapshot_id: manifest.snapshot_id })
      expect(first.next_cursor).toBeDefined()
      expect(
        store.search({ query: "Accounts", domains: ["enterprise"], limit: 1, cursor: first.next_cursor }).items,
      ).toHaveLength(1)
      expect(store.search({ query: "Legacy", domains: ["enterprise"] }).items).toHaveLength(0)
      expect(
        store.search({ query: "Legacy", domains: ["enterprise"], includeDeprecated: true }).items[0]?.attack_id,
      ).toBe("T1999")
      expect(store.get(["T1078.004"], ["enterprise"])[0]).toMatchObject({ subtechnique: true })
      const relationships = store.relationships({
        identifiers: ["G0001"],
        domains: ["enterprise"],
        includeIndirect: true,
      })
      expect(relationships.relationships).toContainEqual(
        expect.objectContaining({
          relationship_type: "uses-via-software",
          indirect: true,
          snapshot_id: manifest.snapshot_id,
        }),
      )
      expect(relationships.objects.every((item) => item.domain === "enterprise")).toBe(true)
      expect(relationships.relationships.every((item) => item.domain === "enterprise")).toBe(true)
      expect(relationships.endpoints.every((item) => item.domain === "enterprise")).toBe(true)
      expect(
        store
          .relationships({
            identifiers: ["G0001"],
            domains: ["enterprise"],
            direction: "incoming",
            includeIndirect: true,
          })
          .relationships.some((item) => item.indirect),
      ).toBe(false)
      expect(
        store.relationships({
          identifiers: ["G0001"],
          domains: ["enterprise"],
          relationshipTypes: ["mitigates"],
          includeIndirect: true,
        }).relationships,
      ).toEqual([])
      expect(relationships.relationships.some((item) => item.revoked)).toBe(false)
      expect(
        store
          .relationships({ identifiers: ["G0001"], domains: ["enterprise"], includeRevoked: true })
          .relationships.some((item) => item.revoked),
      ).toBe(true)
      expect(
        store.matrix({ domain: "enterprise", platform: "Windows", tactics: ["TA0001"], limit: 1 })[0],
      ).toMatchObject({
        snapshot_id: manifest.snapshot_id,
        tactics: [expect.objectContaining({ total_techniques: 1, truncated: false })],
      })
      expect(store.matrix({ domain: "enterprise", tactics: ["initial-access"], limit: 1 })[0]).toMatchObject({
        tactics: [expect.objectContaining({ total_techniques: 2, truncated: true, techniques: [expect.any(Object)] })],
      })
      expect(() =>
        validateAttackRoutingIdentifiers(path.join(output, manifest.database.file), ["T1078", "T1078.004"]),
      ).not.toThrow()
      expect(() => validateAttackRoutingIdentifiers(path.join(output, manifest.database.file), ["T0000"])).toThrow(
        "absent",
      )
    } finally {
      store.close()
    }
  })

  test("publishes one bounded structured MCP tool", async () => {
    const server = await createMitreAttackServer({ databasePath: path.join(output, manifest.database.file), manifest })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "mitre-attack-test", version: "1" })
    await client.connect(clientTransport)
    try {
      const tools = (await client.listTools()).tools
      expect(tools.map((tool) => tool.name)).toEqual(["mitre_attack"])
      const validate = new Ajv2020({ allErrors: true, strictSchema: true, strictTypes: false }).compile(
        tools[0]?.inputSchema as AnySchema,
      )
      expect(validate({ action: "status" })).toBe(true)
      expect(validate({ action: "search", query: "Accounts", limit: 100 })).toBe(true)
      expect(validate({ action: "get", identifiers: ["T1078"] })).toBe(true)
      expect(validate({ action: "relationships", identifiers: ["G0001"], include_indirect: true })).toBe(true)
      expect(validate({ action: "matrix", domain: "enterprise", tactics: ["initial-access"], limit: 50 })).toBe(true)
      expect(validate({ action: "search", query: "Accounts", limit: 101 })).toBe(false)
      expect(validate({ action: "matrix" })).toBe(false)
      expect(validate({ action: "status", query: "Accounts" })).toBe(false)
      const schema = tools[0]?.inputSchema as {
        oneOf?: Array<{
          properties?: { action?: { enum?: string[] }; limit?: { maximum?: number } }
          required?: string[]
        }>
      }
      expect(schema.oneOf?.map((branch) => branch.properties?.action?.enum?.[0])).toEqual([
        "status",
        "search",
        "get",
        "relationships",
        "matrix",
      ])
      expect(
        schema.oneOf?.find((branch) => branch.properties?.action?.enum?.[0] === "search")?.properties?.limit?.maximum,
      ).toBe(100)
      expect(
        schema.oneOf?.find((branch) => branch.properties?.action?.enum?.[0] === "relationships")?.properties?.limit
          ?.maximum,
      ).toBe(500)
      expect(schema.oneOf?.find((branch) => branch.properties?.action?.enum?.[0] === "matrix")?.required).toEqual([
        "action",
        "domain",
      ])
      const status = await client.callTool({ name: "mitre_attack", arguments: { action: "status" } })
      expect(status.structuredContent).toMatchObject({
        status: "ready",
        snapshot: { snapshot_id: manifest.snapshot_id },
      })
      const search = await client.callTool({
        name: "mitre_attack",
        arguments: { action: "search", query: "Valid Accounts", domains: ["enterprise"] },
      })
      expect(search.structuredContent).toMatchObject({
        snapshot: { snapshot_id: manifest.snapshot_id },
        items: [expect.objectContaining({ attack_id: "T1078", snapshot_id: manifest.snapshot_id })],
      })
      expect(
        (
          await client.callTool({
            name: "mitre_attack",
            arguments: { action: "get", identifiers: ["T1078.004"], domains: ["enterprise"] },
          })
        ).structuredContent,
      ).toMatchObject({ items: [expect.objectContaining({ attack_id: "T1078.004" })] })
      expect(
        (
          await client.callTool({
            name: "mitre_attack",
            arguments: {
              action: "relationships",
              identifiers: ["G0001"],
              domains: ["enterprise"],
              relationship_types: ["uses-via-software"],
              include_indirect: true,
            },
          })
        ).structuredContent,
      ).toMatchObject({ relationships: [expect.objectContaining({ indirect: true, domain: "enterprise" })] })
      expect(
        (
          await client.callTool({
            name: "mitre_attack",
            arguments: { action: "matrix", domain: "enterprise", tactics: ["initial-access"], limit: 1 },
          })
        ).structuredContent,
      ).toMatchObject({
        matrices: [expect.objectContaining({ tactics: [expect.objectContaining({ truncated: true })] })],
      })
      const invalidLimit = await client.callTool({
        name: "mitre_attack",
        arguments: { action: "search", query: "Accounts", limit: 101 },
      })
      expect(invalidLimit.isError).toBe(true)
      expect(invalidLimit.structuredContent).toMatchObject({
        error: "INVALID_REQUEST",
        message: "MITRE ATT&CK search limit must be 1 to 100",
      })
      const irrelevantArgument = await client.callTool({
        name: "mitre_attack",
        arguments: { action: "status", query: "Accounts" },
      })
      expect(irrelevantArgument.isError).toBe(true)
      expect(irrelevantArgument.structuredContent).toMatchObject({ error: "INVALID_REQUEST" })
    } finally {
      await client.close()
      await server.close()
    }
  })

  test("restores a missing or corrupted materialization only from embedded bytes", () => {
    const embedded = embeddedAttackSnapshot(output)
    const cache = path.join(root, "cache")
    const materialized = materializeEmbeddedSnapshot(embedded, cache)
    const database = path.join(materialized, embedded.manifest.database.file)
    fs.writeFileSync(database, "corrupt")
    expect(materializeEmbeddedSnapshot(embedded, cache)).toBe(materialized)
    expect(Bun.CryptoHasher.hash("sha256", fs.readFileSync(database), "hex")).toBe(manifest.database.sha256)
  })

  test("attaches the host snapshot without validating agent-declared IDs and reserves final review for Verify", () => {
    const previous = process.env[ATTACK_RUNTIME_DIR_ENV]
    process.env[ATTACK_RUNTIME_DIR_ENV] = output
    try {
      const proposed = {
        applicability: "APPLICABLE",
        mappings: [
          {
            attack_id: "T0000",
            domain: "enterprise",
            rationale: "The agent is procedurally responsible for validating this declared behavior.",
            evidence_refs: ["raw/evidence/declared.json"],
          },
        ],
      }
      expect(parseAttackAssessment(proposed, { phase: "exploit" })).toMatchObject({
        mappings: [{ attack_id: "T0000" }],
        review: "NOT_REVIEWED",
        snapshot: { snapshot_id: manifest.snapshot_id, database_sha256: manifest.database.sha256 },
      })
      expect(() =>
        parseAttackAssessment(
          { ...proposed, review: "ACCEPTED", review_rationale: "Verified against evidence and snapshot." },
          { phase: "exploit" },
        ),
      ).toThrow("only Verify")
      expect(
        parseAttackAssessment(
          { ...proposed, review: "ACCEPTED", review_rationale: "Verified against evidence and snapshot." },
          { phase: "verify" },
        ).review,
      ).toBe("ACCEPTED")
    } finally {
      if (previous === undefined) delete process.env[ATTACK_RUNTIME_DIR_ENV]
      else process.env[ATTACK_RUNTIME_DIR_ENV] = previous
    }
  })

  test("rejects incomplete indices and malformed domain bundles without a cache fallback", async () => {
    expect(() => resolveAttackIndex({ ...index, collections: index.collections.slice(0, 2) })).toThrow(
      "all required domains",
    )
    const malformedOutput = path.join(root, "malformed")
    await expect(
      buildAttackSnapshot({
        outputDir: malformedOutput,
        cyberfulVersion: "1.2.3",
        buildID: "malformed",
        fetchBytes: async (url) => {
          if (url === ATTACK_INDEX_URL) return Buffer.from(JSON.stringify(index))
          if (url === ATTACK_LICENSE_URL) return Buffer.from("The MITRE Corporation grants a royalty-free license.\n")
          const domain = (Object.entries(sourceUrls).find(([, source]) => source === url)?.[0] ??
            "enterprise") as AttackDomain
          const value = bundle(domain)
          if (domain === "enterprise") Object.assign(value.objects[0]!, { x_mitre_domains: ["mobile-attack"] })
          return Buffer.from(JSON.stringify(value))
        },
      }),
    ).rejects.toThrow("does not declare enterprise-attack")
    expect(fs.existsSync(malformedOutput)).toBe(false)
  })

  test("keeps ATT&CK explicitly non-exhaustive for Firefox, IDOR, credential stuffing, and zero-days", async () => {
    const skill = await Bun.file(
      path.resolve(import.meta.dir, "../../builtin/skills/operate-mitre-attack/SKILL.md"),
    ).text()
    const reference = await Bun.file(
      path.resolve(import.meta.dir, "../../builtin/skills/operate-mitre-attack/references/applicability-and-review.md"),
    ).text()
    expect(skill).toContain("generic Firefox defect")
    expect(skill).toContain("credential stuffing")
    expect(skill).toContain("zero-days")
    expect(skill).toContain('{"action":"status"}')
    expect(skill).toContain('{"action":"search"')
    expect(skill).toContain('{"action":"get"')
    expect(skill).toContain('{"action":"relationships"')
    expect(skill).toContain('{"action":"matrix"')
    expect(skill).toContain('"action": "set_attack_assessment"')
    expect(skill).toContain("INVALID_REQUEST")
    expect(reference).toContain("IDOR")
    expect(reference).toContain("ATT&CK coverage and vulnerability coverage as independent dimensions")
  })
})
