// ── Control-Plane Runtime Identity ──────────────────────────────
// Captures build, run, process, and start identities once and exposes that
// stable snapshot with the installation version in the server health response.
// → cyberful/src/server/routes/instance/httpapi/groups/global.ts — declares the public schema.
// ─────────────────────────────────────────────────────────────────

import { InstallationVersion } from "@/installation/version"
import { ensureProcessMetadata } from "@/util/cyberful-process"

const processMetadata = ensureProcessMetadata("main")

export function healthPayload() {
  return {
    healthy: true as const,
    version: InstallationVersion,
    buildID: processMetadata.buildID,
    runID: processMetadata.runID,
    pid: processMetadata.pid,
    startedAt: processMetadata.startedAt,
  }
}

export * as RuntimeIdentity from "./runtime-identity"
