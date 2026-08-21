#!/usr/bin/env bun
// ── Release MITRE ATT&CK Snapshot Preparation ────────────────────
// Resolves one official build-time snapshot for reuse by every native release
// job, then verifies the skill-routing identifiers against its exact database.
// → .github/workflows/release.yml — uploads this directory once per release.
// → cyberful/script/build.ts — verifies and embeds the prepared directory.
// @docs/runtimes/mitre-attack.md
// ─────────────────────────────────────────────────────────────────

import fs from "node:fs"
import path from "node:path"
import {
  buildAttackSnapshot,
  embeddedAttackSnapshot,
  validateAttackRoutingIdentifiers,
} from "../src/mitre-attack/builder"

function argument(name: string) {
  const indexes = Bun.argv.flatMap((value, index) => (value === name ? [index] : []))
  if (indexes.length > 1) throw new Error(`${name} may be passed only once`)
  if (indexes.length === 0) return
  const value = Bun.argv[indexes[0] + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

function routingIdentifiers() {
  const filename = path.resolve(import.meta.dir, "../builtin/skills/framework-identifiers.json")
  const source = JSON.parse(fs.readFileSync(filename, "utf8")) as {
    frameworks?: { mitre_attack?: { identifiers?: unknown } }
  }
  const identifiers = source.frameworks?.mitre_attack?.identifiers
  if (!Array.isArray(identifiers) || !identifiers.every((value) => typeof value === "string")) {
    throw new Error("Built-in MITRE ATT&CK routing identifiers are invalid")
  }
  return identifiers
}

const output = argument("--output")
const cyberfulVersion = argument("--cyberful-version")
const buildID = argument("--build-id")
if (!output || !cyberfulVersion || !buildID) {
  throw new Error("--output, --cyberful-version, and --build-id are required")
}

const manifest = await buildAttackSnapshot({
  outputDir: path.resolve(output),
  cyberfulVersion,
  buildID,
})
const embedded = embeddedAttackSnapshot(path.resolve(output))
validateAttackRoutingIdentifiers(path.resolve(output, embedded.manifest.database.file), routingIdentifiers())
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
