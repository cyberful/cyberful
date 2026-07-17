// ── Engagement-Scoped ZAP Report Paths ──────────────────────────────
// Canonicalizes report destinations beneath the mounted workarea and converts
// requested sites to credential-free origins for ZAP's server-side filter.
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

// ZAP's Reports API accepts a pipe-delimited list of sites. Canonical origins keep that server-side
// filter exact and prevent credentials, paths, queries, or fragments from being mistaken for scope.
export function engagementReportSites(requestedSites) {
  if (!Array.isArray(requestedSites) || !requestedSites.length)
    throw new Error("at least one authorized report site is required")

  return requestedSites
    .map((requested) => {
      if (typeof requested !== "string") throw new Error("report sites must be absolute HTTP(S) origins")
      const url = URL.parse(requested.trim())
      if (!url || !/^https?:$/.test(url.protocol)) throw new Error("report sites must be absolute HTTP(S) origins")
      if (url.username || url.password) throw new Error("report sites must not contain credentials")
      if (url.pathname !== "/" || url.search || url.hash)
        throw new Error("report sites must be origins without a path, query, or fragment")
      return url.origin
    })
    .filter((site, index, sites) => sites.indexOf(site) === index)
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
