// ── Completion Card Semantics ────────────────────────────────────
// Maps durable completion outcomes to the compact tone and status labels shared
//   by session rendering and transcript-oriented presentation.
// ─────────────────────────────────────────────────────────────────

import type { CompletionPart } from "@/server/client"

export function tone(outcome: CompletionPart["outcome"]): "success" | "warning" | "error" {
  if (outcome === "success") return "success"
  if (outcome === "failed") return "error"
  return "warning"
}

export function statusLabel(outcome: CompletionPart["outcome"]) {
  if (outcome === "success") return "COMPLETED"
  if (outcome === "warning") return "COMPLETED WITH WARNINGS"
  return outcome === "blocked" ? "BLOCKED" : "FAILED"
}

export * as CompletionCard from "./completion-card"
