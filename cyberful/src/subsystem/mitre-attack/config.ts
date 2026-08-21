// ── MITRE ATT&CK MCP Process Configuration ──────────────────────
// Resolves the source or release-binary command used by the phase gateway to
// launch the build-embedded ATT&CK server as a private stdio upstream.
// → cyberful/src/subsystem/upstream.ts — registers the command.
// → cyberful/src/index.ts — dispatches compiled-binary re-entry.
// @docs/runtimes/mitre-attack.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"

declare const CYBERFUL_BUILT: string

const isCompiledBinary = typeof CYBERFUL_BUILT !== "undefined"

export const MITRE_ATTACK_ARGV = "__cyberful-mitre-attack-mcp__"

export function mitreAttackMcpCommand() {
  if (isCompiledBinary) return [process.execPath, MITRE_ATTACK_ARGV]
  return [process.execPath, path.join(import.meta.dir, "server.ts")]
}

