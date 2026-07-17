// ── Sync Projector Bootstrap ────────────────────────────────────
// Registers session synchronization projectors as a deliberate server startup
// side effect before the control-plane application begins handling requests.
// → cyberful/src/server/projectors.ts — owns projector registration.
// ─────────────────────────────────────────────────────────────────

import { initProjectors } from "./projectors"

initProjectors()
