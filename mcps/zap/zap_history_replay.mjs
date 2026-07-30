// ── Bounded ZAP History Replay Mutation ─────────────────────────
// Clones one ZAP-owned HTTP message while applying explicit header, query, and
//   JSON body mutations without returning captured credentials to the caller.
// The destination path, authority, scheme, and method remain immutable; only
// caller-named fields change and Content-Length is rebuilt from the final body.
// → mcps/zap/zap_bridge.mjs — reads history and sends the normalized clone.
// @docs/runtimes/zap.md
// ─────────────────────────────────────────────────────────────────

const MAX_MUTATIONS = 32
const MAX_BODY_BYTES = 2 * 1024 * 1024

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function mutationArray(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_MUTATIONS)
    throw new Error(`${label} must contain at most ${MAX_MUTATIONS} mutations`)
  return value.map((item, index) => record(item, `${label}[${index}]`))
}

function safeName(value, label) {
  if (typeof value !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(value))
    throw new Error(`${label} is invalid`)
  return value
}

function pointerSegments(pointer) {
  if (typeof pointer !== "string" || (!pointer.startsWith("/") && pointer !== ""))
    throw new Error("JSON mutation path must be a JSON Pointer")
  return pointer === ""
    ? []
    : pointer.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
}

function mutateJson(root, mutation) {
  const operation = mutation.op
  if (!["add", "replace", "remove"].includes(operation)) throw new Error("JSON mutation op is invalid")
  const segments = pointerSegments(mutation.path)
  if (segments.length === 0) {
    if (operation === "remove") throw new Error("the JSON document root cannot be removed")
    if (!("value" in mutation)) throw new Error(`${operation} requires a value`)
    return mutation.value
  }
  let parent = root
  for (const segment of segments.slice(0, -1)) {
    if (!parent || typeof parent !== "object") throw new Error(`JSON Pointer parent '${segment}' does not exist`)
    parent = parent[segment]
  }
  if (!parent || typeof parent !== "object") throw new Error("JSON Pointer parent does not exist")
  const key = segments.at(-1)
  if (operation === "remove") {
    if (Array.isArray(parent)) {
      const index = Number(key)
      if (!Number.isSafeInteger(index) || index < 0 || index >= parent.length) throw new Error("JSON array index is invalid")
      parent.splice(index, 1)
    } else {
      if (!(key in parent)) throw new Error("JSON Pointer target does not exist")
      delete parent[key]
    }
    return root
  }
  if (!("value" in mutation)) throw new Error(`${operation} requires a value`)
  if (Array.isArray(parent)) {
    const index = key === "-" ? parent.length : Number(key)
    if (!Number.isSafeInteger(index) || index < 0 || index > parent.length) throw new Error("JSON array index is invalid")
    if (operation === "replace") {
      if (index >= parent.length) throw new Error("JSON Pointer target does not exist")
      parent[index] = mutation.value
    } else parent.splice(index, 0, mutation.value)
  } else {
    if (operation === "replace" && !(key in parent)) throw new Error("JSON Pointer target does not exist")
    parent[key] = mutation.value
  }
  return root
}

function sourceUrl(message, requestTarget, headers) {
  const direct = typeof message.url === "string" ? URL.parse(message.url) : undefined
  if (direct && /^https?:$/.test(direct.protocol)) return direct
  const absolute = URL.parse(requestTarget)
  if (absolute && /^https?:$/.test(absolute.protocol)) return absolute
  const host = headers.find(([name]) => name.toLowerCase() === "host")?.[1]
  if (!host || !requestTarget.startsWith("/")) throw new Error("captured message has no unambiguous HTTP destination")
  return new URL(`${message.tls === "true" ? "https" : "http"}://${host}${requestTarget}`)
}

export function replayRequest(messageValue, args = {}) {
  const message = record(messageValue, "ZAP history message")
  const headerText = typeof message.requestHeader === "string" ? message.requestHeader : ""
  const lines = headerText.split(/\r?\n/).filter((line, index, all) => index === 0 || line || index < all.length - 1)
  const requestLine = lines.shift()?.match(/^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s+(\S+)\s+(HTTP\/1\.[01])$/)
  if (!requestLine) throw new Error("captured request line is invalid")
  const headers = lines.filter(Boolean).map((line) => {
    const separator = line.indexOf(":")
    if (separator < 1) throw new Error("captured request contains an invalid header")
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
  })
  const url = sourceUrl(message, requestLine[2], headers)
  const original = new URL(url)
  const headerMutations = mutationArray(args.header_mutations, "header_mutations")
  const queryMutations = mutationArray(args.query_mutations, "query_mutations")
  const bodyMutations = mutationArray(args.json_body_mutations, "json_body_mutations")
  if (headerMutations.length + queryMutations.length + bodyMutations.length > MAX_MUTATIONS)
    throw new Error(`replay accepts at most ${MAX_MUTATIONS} total mutations`)

  for (const mutation of queryMutations) {
    const name = typeof mutation.name === "string" && mutation.name ? mutation.name : undefined
    if (!name) throw new Error("query mutation name is required")
    if (mutation.op === "remove") url.searchParams.delete(name)
    else if (mutation.op === "set" && typeof mutation.value === "string") url.searchParams.set(name, mutation.value)
    else throw new Error("query mutation must be set with a string value or remove")
  }
  if (url.origin !== original.origin || url.pathname !== original.pathname)
    throw new Error("replay mutations cannot change the captured destination")

  const mutableHeaders = headers.filter(([name]) => !["content-length"].includes(name.toLowerCase()))
  for (const mutation of headerMutations) {
    const name = safeName(mutation.name, "header mutation name")
    if (name.toLowerCase() === "host" || name.toLowerCase() === "content-length")
      throw new Error(`${name} is host-owned during replay`)
    const indexes = mutableHeaders.flatMap(([candidate], index) =>
      candidate.toLowerCase() === name.toLowerCase() ? [index] : [],
    )
    if (mutation.op === "remove") {
      for (const index of indexes.reverse()) mutableHeaders.splice(index, 1)
    } else if (mutation.op === "set" && typeof mutation.value === "string") {
      for (const index of indexes.reverse()) mutableHeaders.splice(index, 1)
      mutableHeaders.push([name, mutation.value])
    } else throw new Error("header mutation must be set with a string value or remove")
  }

  let body = typeof message.requestBody === "string" ? message.requestBody : ""
  if (bodyMutations.length > 0) {
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("captured JSON body is too large to mutate")
    let json
    try {
      json = JSON.parse(body)
    } catch {
      throw new Error("json_body_mutations require a valid captured JSON body")
    }
    for (const mutation of bodyMutations) json = mutateJson(json, mutation)
    body = JSON.stringify(json)
  }
  if (body) mutableHeaders.push(["Content-Length", String(Buffer.byteLength(body))])

  return {
    request: [
      `${requestLine[1]} ${url.href} ${requestLine[3]}`,
      ...mutableHeaders.map(([name, value]) => `${name}: ${value}`),
      "",
      body,
    ].join("\r\n"),
    targetUrl: url.href,
    mutationSummary: {
      headers: headerMutations.map((mutation) => ({ op: mutation.op, name: mutation.name })),
      query: queryMutations.map((mutation) => ({ op: mutation.op, name: mutation.name })),
      json: bodyMutations.map((mutation) => ({ op: mutation.op, path: mutation.path })),
    },
  }
}
