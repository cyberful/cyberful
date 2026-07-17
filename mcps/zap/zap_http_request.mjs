// ── Raw HTTP Request Destination Boundary ───────────────────────────
// Validates raw request lines and preserves absolute HTTPS destinations before
// ZAP sees them. Origin-form requests require an explicit same-origin target
// because ZAP cannot safely infer their scheme from the request bytes alone.
// → mcps/zap/zap_bridge.mjs — exposes this guarded host-owned API operation.
// ────────────────────────────────────────────────────────────────────

export function normalizedHttpRequest(request, targetUrl) {
  if (typeof request !== "string" || !request.trim()) throw new Error("zap_http_request requires a raw request")

  const firstLine = request.match(/^([^\r\n]+)(\r?\n)/)
  if (!firstLine) throw new Error("raw request must contain a request line followed by headers")
  const parsedLine = firstLine[1].match(/^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s+(\S+)\s+(HTTP\/1\.[01])$/)
  if (!parsedLine) throw new Error("raw request line must be METHOD request-target HTTP/1.0 or HTTP/1.1")

  const destination = targetUrl === undefined ? undefined : absoluteHttpUrl(targetUrl, "target_url")
  const requestTarget = parsedLine[2]
  const absoluteTarget = /^https?:\/\//i.test(requestTarget)
    ? absoluteHttpUrl(requestTarget, "request target")
    : undefined
  if (!absoluteTarget && !requestTarget.startsWith("/"))
    throw new Error("raw request target must be absolute-form or origin-form")
  if (!absoluteTarget && !destination)
    throw new Error("origin-form raw requests require target_url so ZAP cannot guess the scheme")

  const effective = absoluteTarget ?? destination
  if (!effective) throw new Error("an absolute request destination is required")
  if (absoluteTarget && destination && canonicalUrl(absoluteTarget) !== canonicalUrl(destination))
    throw new Error("target_url must exactly match the absolute raw request target")
  if (!absoluteTarget && requestTarget !== `${effective.pathname}${effective.search}`)
    throw new Error("origin-form request path and query must exactly match target_url")

  const headerBoundary = request.slice(firstLine[0].length).match(/^([\s\S]*?)(\r?\n\r?\n)/)
  if (!headerBoundary) throw new Error("raw request headers must end with a blank line")
  const headerBlock = headerBoundary[1]
  const hosts = headerBlock.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^host\s*:\s*(.+?)\s*$/i)
    return match ? [match[1]] : []
  })
  if (hosts.length !== 1) throw new Error("raw request must contain exactly one Host header")
  if (/[/\\?#@\s]/.test(hosts[0])) throw new Error("Host header must contain only a host and optional port")
  if (new URL(`${effective.protocol}//${hosts[0]}`).host !== effective.host)
    throw new Error("Host header must match the effective request destination")

  const effectiveTarget = canonicalUrl(effective)
  return {
    request: absoluteTarget
      ? request
      : `${parsedLine[1]} ${effectiveTarget} ${parsedLine[3]}${firstLine[2]}${request.slice(firstLine[0].length)}`,
    targetUrl: effectiveTarget,
    scheme: effective.protocol.slice(0, -1),
    normalizedOriginForm: !absoluteTarget,
  }
}

export function recordedRequestTarget(result) {
  const header = result?.sendRequest?.[0]?.requestHeader
  if (typeof header !== "string") throw new Error("ZAP sendRequest returned no recorded request header")
  const target = header.split(/\r?\n/, 1)[0]?.match(/^\S+\s+(\S+)\s+HTTP\/1\.[01]$/)?.[1]
  if (!target || !/^https?:\/\//i.test(target))
    throw new Error("ZAP sendRequest returned an ambiguous recorded request target")
  return canonicalUrl(absoluteHttpUrl(target, "recorded request target"))
}

function absoluteHttpUrl(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be an absolute HTTP(S) URL`)
  const url = URL.parse(value)
  if (!url) throw new Error(`${label} must be an absolute HTTP(S) URL`)
  if (!/^https?:$/.test(url.protocol)) throw new Error(`${label} must use http or https`)
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`)
  if (url.hash) throw new Error(`${label} must not contain a fragment`)
  return url
}

function canonicalUrl(url) {
  return `${url.origin}${url.pathname}${url.search}`
}
