#!/usr/bin/env bun
// ── npm Release Artifact Optimization ───────────────────────────────
// Applies the package assembler's bounded, byte-preserving compression policy
// to one existing npm tarball so a staged partial release can resume safely.
// → cyberful/script/package-npm.ts — owns the compression and integrity checks.
// @docs/development/release.md
// ────────────────────────────────────────────────────────────────────

import path from "node:path"
import { optimizeNpmPackage } from "../cyberful/script/package-npm"

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
const result = await optimizeNpmPackage(packageFile)
console.log(JSON.stringify({ file: packageFile, ...result }, null, 2))
