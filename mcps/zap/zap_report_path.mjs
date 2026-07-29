// ── Engagement ZAP Report Paths ─────────────────────────────────────
// Canonicalizes report destinations beneath the mounted workarea without
// filtering the sites collected by ZAP.
// → mcps/zap/zap_bridge.mjs — applies these constraints to report generation.
// ────────────────────────────────────────────────────────────────────

import path from "node:path"
export function engagementReportPath(requestedPath, workarea) {
  const requested = typeof requestedPath === "string" ? requestedPath.trim() : ""
  if (!requested) throw new Error("a report filename is required")

  const root = path.posix.resolve(workarea)
  const containerPath = path.posix.isAbsolute(requested)
    ? path.posix.normalize(requested)
    : path.posix.resolve(root, requested)
  if (containerPath !== root && !containerPath.startsWith(`${root}/`))
    throw new Error(`ZAP reports must be written inside the engagement workarea ${root}`)

  const engagementPath = path.posix.relative(root, containerPath)
  if (!engagementPath) throw new Error("a report filename is required, not the engagement workarea root")
  return { containerPath, engagementPath }
}

export function withEngagementReportPath(result, reportPath) {
  if (result?.isError) return result
  return {
    ...result,
    content: [
      ...(Array.isArray(result?.content) ? result.content : []),
      {
        type: "text",
        text: JSON.stringify({
          engagement_root_relative_path: reportPath.engagementPath,
          container_path: reportPath.containerPath,
        }),
      },
    ],
  }
}
