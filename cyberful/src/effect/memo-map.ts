// ── Shared Effect Layer Memoization ────────────────────────────────
// Provides the explicit process-lifetime memo map used by managed runtimes so
// identical layers share their scoped services rather than initializing twice.
// → cyberful/src/effect/app-runtime.ts — owns the primary managed runtime.
// ────────────────────────────────────────────────────────────────────

import { Layer } from "effect"

export const memoMap = Layer.makeMemoMapUnsafe()
