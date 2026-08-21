// ── Engagement ZAP Report Paths ─────────────────────────────────────
// Canonicalizes report destinations beneath the mounted workarea and validates
// optional Reports API site filters as exact HTTP(S) origins.
// → mcps/zap/zap_bridge.mjs — applies these constraints to report generation.
// ────────────────────────────────────────────────────────────────────

import path from "node:path"

export function normalizedReportSites(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    throw new Error("ZAP report sites must contain between 1 and 100 origins")
  const sites = value.map((candidate, index) => {
    if (typeof candidate !== "string" || candidate !== candidate.trim())
      throw new Error(`ZAP report sites[${index}] must be a normalized HTTP(S) origin`)
    let parsed
    try {
      parsed = new URL(candidate)
    } catch {
      throw new Error(`ZAP report sites[${index}] must be a normalized HTTP(S) origin`)
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== candidate)
      throw new Error(`ZAP report sites[${index}] must be a normalized HTTP(S) origin`)
    return parsed.origin
  })
  if (new Set(sites).size !== sites.length) throw new Error("ZAP report sites must be unique")
  return sites
}

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
