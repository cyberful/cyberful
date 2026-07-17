// ── Codex Live Steering Adapter ──────────────────────────────────
// Registers an active app-server turn with generic session control and translates
// Codex acknowledgement without leaking thread or JSON-RPC details into session code.
// → cyberful/src/subsystem/control.ts — owns the runtime-neutral steering contract.
// ─────────────────────────────────────────────────────────────────

import { SubsystemControl } from "./control"

// Codex's app-server acknowledgement is intentionally translated at this edge. The session journal and
// composer depend only on SubsystemControl, so another runtime can implement live steering without
// importing Codex thread ids, turn ids, or JSON-RPC semantics into host-level code.

export interface ActiveCodexTurn {
  steer(text: string): Promise<boolean>
}

export function register(sessionID: string, turn: ActiveCodexTurn): () => void {
  return SubsystemControl.register(sessionID, {
    steer: async (request) => {
      const accepted = await turn.steer(request.text)
      return { accepted, recipients: accepted ? 1 : 0 }
    },
  })
}

export * as SubsystemCodexControl from "./codex-control"
