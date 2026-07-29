// ── Pi OAuth Standalone Bootstrap ───────────────────────────────
// Registers Pi's OAuth implementations as static bundle dependencies so
//   compiled Cyberful binaries can authenticate without a node_modules tree.
// → cyberful/src/subsystem/pi-models.ts — evaluates this bootstrap in every
//   process or Worker isolate that materializes provider authentication.
// ─────────────────────────────────────────────────────────────────

import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth"

// ── Standalone Binaries Cannot Follow Pi's Lazy OAuth Imports ───
// Pi normally keeps Node-only OAuth implementations behind variable dynamic
// imports. Bun deliberately cannot discover those imports while compiling a
// standalone executable, and a release contains no package files to load later.
// Static registration makes the same provider-owned flows reachable in source,
// the main executable, and the separately compiled TUI Worker while preserving
// Pi's lazy provider-facing auth contract.
// ─────────────────────────────────────────────────────────────────
registerBunOAuthFlows()

export const piOAuthFlowsRegistered = true
