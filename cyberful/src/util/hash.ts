// ── Stable Cache Fingerprints ────────────────────────────────────
// Produces fast deterministic SHA-1 identifiers for cache keys and snapshots;
// these hashes are not used as security or authenticity proofs.
// → cyberful/src/snapshot/index.ts — isolates private Git state by worktree fingerprint.
// ─────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"

export namespace Hash {
  export function fast(input: string | Buffer): string {
    return createHash("sha1").update(input).digest("hex")
  }
}
