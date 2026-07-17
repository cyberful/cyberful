// ── ZAP Phase Policy ──────────────────────────────────────────────
// Rejects report-generation calls that violate Recon concurrency or terminal
// report scoping before the request can reach the ZAP upstream.
// → cyberful/src/subsystem/gateway/server.ts — applies this policy to proxied calls.
// ─────────────────────────────────────────────────────────────────
export function zapPhaseToolError(phase: string | undefined, toolName: string) {
  if (phase === "report" && toolName === "zap_generate_report")
    return "The client ZAP artifact must use zap_generate_scoped_report with the authorized site origins; unscoped report generation is blocked in the Report phase."
  if (phase !== "recon" || !["zap_generate_report", "zap_generate_scoped_report"].includes(toolName)) return
  return "ZAP report generation is deferred until after Recon completes; keep traffic evidence in history and let a later phase generate the engagement-root report."
}
