// ── Local-Only Effect Observability ────────────────────────────────
// Installs Cyberful's structured logger for Effect runtimes while deliberately
// exposing no telemetry exporter, endpoint, headers, or background network path.
// → cyberful/src/effect/logger.ts — renders logs to repository-owned local sinks.
// ────────────────────────────────────────────────────────────────────

import * as EffectLogger from "./logger"

export const enabled = false
export const layer = EffectLogger.layer

export const Observability = { enabled, layer }
