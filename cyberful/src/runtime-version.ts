// ── Embedded Runtime Version Attestation ─────────────────────────────────
// Exposes the exact Pi packages resolved into a Cyberful source run or binary
// through one private build-time and installation-time attestation command.
// → cyberful/script/build.ts — rejects binaries that report another Pi build.
// → scripts/update_pi.py — rechecks the installed current-platform binary.
// @docs/development/README.md
// ───────────────────────────────────────────────────────────────────

import cyberfulPackage from "../package.json"

export const RUNTIME_VERSION_ARGV = "--cyberful-runtime-version"

export const embeddedRuntimeVersions = {
  piAgentCore: cyberfulPackage.dependencies["@earendil-works/pi-agent-core"],
  piAi: cyberfulPackage.dependencies["@earendil-works/pi-ai"],
} as const
