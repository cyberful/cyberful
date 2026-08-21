#!/usr/bin/env bun
// ── Compiled MITRE ATT&CK MCP Smoke Test ─────────────────────────
// Starts every host-compatible release binary through its private stdio entry,
// proves its discriminated tool contract and embedded snapshot queries match
// the build manifest, and supplies no usable runtime network route.
// → cyberful/src/subsystem/mitre-attack/server.ts — serves the tested MCP tool.
// → .github/workflows/release.yml — runs this before packaging each platform.
// @docs/runtimes/mitre-attack.md
// ─────────────────────────────────────────────────────────────────

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { MITRE_ATTACK_ARGV } from "../src/subsystem/mitre-attack/config"
import type { AttackSnapshotManifest } from "../src/mitre-attack/types"

function argument(name: string) {
  const indexes = Bun.argv.flatMap((value, index) => (value === name ? [index] : []))
  if (indexes.length > 1) throw new Error(`${name} may be passed only once`)
  if (indexes.length === 0) return
  const value = Bun.argv[indexes[0] + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

function hostBinaries(root: string) {
  const platform = process.platform === "win32" ? "windows" : process.platform
  const prefix = `cyberful-${platform}-${process.arch}`
  return Array.from(new Bun.Glob("**/bin/cyberful{,.exe}").scanSync({ cwd: root, onlyFiles: true }))
    .filter((relative) =>
      relative
        .replaceAll("\\", "/")
        .split("/")
        .some((part) => part.startsWith(prefix)),
    )
    .map((relative) => path.resolve(root, relative))
    .toSorted()
}

async function smoke(binary: string, manifest: AttackSnapshotManifest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-mitre-attack-smoke-"))
  const environment: Record<string, string> = {
    ...getDefaultEnvironment(),
    CYBERFUL_TEST_HOME: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
  }
  delete environment.CYBERFUL_MITRE_ATTACK_DIR
  const transport = new StdioClientTransport({
    command: binary,
    args: [MITRE_ATTACK_ARGV],
    cwd: root,
    env: environment,
    stderr: "pipe",
  })
  const client = new Client({ name: "cyberful-mitre-attack-release-smoke", version: "1.0.0" })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    if (tools.tools.length !== 1 || tools.tools[0]?.name !== "mitre_attack") {
      throw new Error(`${binary} did not publish the single expected MITRE ATT&CK tool`)
    }
    const branches = (
      tools.tools[0].inputSchema as {
        oneOf?: Array<{ properties?: { action?: { enum?: string[] }; limit?: { maximum?: number } } }>
      }
    ).oneOf
    const actions = branches?.map((branch) => branch.properties?.action?.enum?.[0])
    if (JSON.stringify(actions) !== JSON.stringify(["status", "search", "get", "relationships", "matrix"])) {
      throw new Error(`${binary} did not publish the five discriminated MITRE ATT&CK actions`)
    }
    if (
      branches?.find((branch) => branch.properties?.action?.enum?.[0] === "search")?.properties?.limit?.maximum !== 100
    ) {
      throw new Error(`${binary} published a MITRE ATT&CK search limit that differs from its runtime contract`)
    }
    const response = await client.callTool({ name: "mitre_attack", arguments: { action: "status" } })
    const structured = response.structuredContent as
      | { status?: unknown; snapshot?: { snapshot_id?: unknown; database?: { sha256?: unknown } } }
      | undefined
    if (
      response.isError ||
      structured?.status !== "ready" ||
      structured.snapshot?.snapshot_id !== manifest.snapshot_id ||
      structured.snapshot.database?.sha256 !== manifest.database.sha256
    ) {
      throw new Error(`${binary} MITRE ATT&CK status does not match the build manifest`)
    }
    const matrix = await client.callTool({
      name: "mitre_attack",
      arguments: { action: "matrix", domain: "enterprise", limit: 1 },
    })
    const matrixContent = matrix.structuredContent as
      | {
          snapshot?: { snapshot_id?: unknown }
          matrices?: Array<{ tactics?: Array<{ techniques?: Array<{ attack_id?: unknown }> }> }>
        }
      | undefined
    const attackID = matrixContent?.matrices
      ?.flatMap((item) => item.tactics ?? [])
      .flatMap((item) => item.techniques ?? [])[0]?.attack_id
    if (
      matrix.isError ||
      matrixContent?.snapshot?.snapshot_id !== manifest.snapshot_id ||
      typeof attackID !== "string"
    ) {
      throw new Error(`${binary} could not query one bounded Enterprise ATT&CK matrix`)
    }
    const search = await client.callTool({
      name: "mitre_attack",
      arguments: { action: "search", query: attackID, domains: ["enterprise"], limit: 1 },
    })
    const searchContent = search.structuredContent as
      | { items?: unknown[]; snapshot?: { snapshot_id?: unknown } }
      | undefined
    if (
      search.isError ||
      searchContent?.snapshot?.snapshot_id !== manifest.snapshot_id ||
      !searchContent.items?.length
    ) {
      throw new Error(`${binary} could not search its embedded MITRE ATT&CK snapshot`)
    }
    const exact = await client.callTool({
      name: "mitre_attack",
      arguments: { action: "get", identifiers: [attackID], domains: ["enterprise"] },
    })
    const exactContent = exact.structuredContent as
      | { items?: unknown[]; snapshot?: { snapshot_id?: unknown } }
      | undefined
    if (exact.isError || exactContent?.snapshot?.snapshot_id !== manifest.snapshot_id || !exactContent.items?.length) {
      throw new Error(`${binary} could not resolve an exact embedded MITRE ATT&CK identifier`)
    }
    const relationships = await client.callTool({
      name: "mitre_attack",
      arguments: { action: "relationships", identifiers: [attackID], domains: ["enterprise"], limit: 1 },
    })
    const relationshipContent = relationships.structuredContent as
      | { relationships?: unknown[]; snapshot?: { snapshot_id?: unknown } }
      | undefined
    if (
      relationships.isError ||
      relationshipContent?.snapshot?.snapshot_id !== manifest.snapshot_id ||
      !Array.isArray(relationshipContent.relationships)
    ) {
      throw new Error(`${binary} could not traverse its embedded MITRE ATT&CK relationships`)
    }
    const invalid = await client.callTool({
      name: "mitre_attack",
      arguments: { action: "status", query: attackID },
    })
    if (!invalid.isError)
      throw new Error(`${binary} accepted a field outside the selected MITRE ATT&CK action contract`)
  } finally {
    await client.close().catch(() => undefined)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const root = argument("--root")
const manifestFile = argument("--manifest")
if (!root || !manifestFile) throw new Error("--root and --manifest are required")
const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestFile), "utf8")) as AttackSnapshotManifest
const binaries = hostBinaries(path.resolve(root))
if (binaries.length === 0) throw new Error("No host-compatible Cyberful release binary was found")
for (const binary of binaries) {
  await smoke(binary, manifest)
  console.log(`MITRE ATT&CK MCP smoke passed: ${binary}`)
}
