// ── Typed Control-Plane Client Assembly ─────────────────────────
// Wraps the generated API client with directory routing, merged headers, and
// consistent thrown-error translation for Cyberful control-plane requests.
// → cyberful/src/server/client/error.ts — translates generated client errors.
// ─────────────────────────────────────────────────────────────────

export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import type { Config } from "./gen/client/types.gen.js"
import { mergeHeaders } from "./gen/client/utils.gen.js"
import { ControlPlaneClient } from "./gen/sdk.gen.js"
import { wrapClientError } from "./error"

export { ControlPlaneClient }

export type ControlPlaneClientOptions = Config & {
  directory?: string
}

function pick(value: string | null, fallback?: string, encode?: (value: string) => string) {
  if (!value) return
  if (!fallback) return value
  if (value === fallback) return fallback
  if (encode && value === encode(fallback)) return fallback
  return value
}

function rewrite(request: Request, context: { directory?: string }) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const values = [
    {
      header: "x-cyberful-directory",
      parameter: "directory",
      fallback: context.directory,
      encode: encodeURIComponent,
    },
  ].flatMap((item) => {
    const value = pick(request.headers.get(item.header), item.fallback, item.encode)
    if (!value) return []
    return [{ header: item.header, parameter: item.parameter, value }]
  })

  if (values.length === 0) return request

  const url = new URL(request.url)
  values.forEach((item) => {
    if (!url.searchParams.has(item.parameter)) url.searchParams.set(item.parameter, item.value)
  })

  const next = new Request(url, request)
  values.forEach((item) => next.headers.delete(item.header))
  return next
}

const fetchWithoutTimeout = ((request: Request) => {
  // Generated requests can legitimately stream for longer than Bun's default request timeout.
  Reflect.set(request, "timeout", false)
  return fetch(request)
}) as typeof fetch

export function createControlPlaneClient(options?: ControlPlaneClientOptions) {
  const headers = mergeHeaders(options?.headers)
  if (options?.directory) headers.set("x-cyberful-directory", encodeURIComponent(options.directory))

  const client = createClient({
    ...options,
    fetch: options?.fetch ?? fetchWithoutTimeout,
    headers,
  })
  client.interceptors.request.use((request) =>
    rewrite(request, {
      directory: options?.directory,
    }),
  )
  client.interceptors.response.use((response) => {
    if (response.headers.get("content-type") === "text/html") {
      throw new Error("Request is not supported by this Cyberful server (server responded with text/html)")
    }
    return response
  })
  client.interceptors.error.use(wrapClientError)
  return new ControlPlaneClient({ client })
}
