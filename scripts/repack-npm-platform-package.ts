#!/usr/bin/env bun
// ── npm x64 Release Artifact Repacking ─────────────────────────────
// Rewrites one staged Linux or Windows x64 npm tarball around one regular
// baseline-compatible binary exposed under the canonical public filename.
// → cyberful/script/package-npm.ts — owns archive validation and repacking.
// ────────────────────────────────────────────────────────────────────

import path from "node:path"
import { repackUniversalX64Package } from "../cyberful/script/package-npm"

function argument(name: string) {
  const indexes = Bun.argv.flatMap((value, index) => (value === name ? [index] : []))
  if (indexes.length > 1) throw new Error(`${name} may be passed only once`)
  if (indexes.length === 0) return
  const value = Bun.argv[indexes[0] + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

const file = argument("--file")
if (!file) throw new Error("--file is required")
const packageFile = path.resolve(file)
const result = await repackUniversalX64Package(packageFile)
console.log(JSON.stringify({ file: packageFile, ...result }, null, 2))
