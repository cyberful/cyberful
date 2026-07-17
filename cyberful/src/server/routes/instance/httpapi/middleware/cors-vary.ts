// ── Dynamic-Origin Cache Isolation ──────────────────────────────
// Ensures responses that echo an allowed request origin also vary by Origin,
// preventing shared caches from reusing one origin's preflight for another.
// → cyberful/src/server/routes/instance/httpapi/server.ts — installs this after CORS handling.
// ─────────────────────────────────────────────────────────────────

import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"

// ── Preflight Responses Vary By Dynamic Origin ──────────────────
// The upstream CORS middleware composes Origin and requested-header decisions
// into one response record, where the latter can overwrite the former's Vary
// value. Cyberful echoes approved origins instead of returning a wildcard, so a
// shared cache must key those responses by Origin. This middleware merges that
// token without duplicating an existing Origin or wildcard entry.
// ─────────────────────────────────────────────────────────────────
export const corsVaryFix = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      const response = yield* effect
      const allowOrigin = response.headers["access-control-allow-origin"]
      if (!allowOrigin || allowOrigin === "*") return response

      const vary = response.headers["vary"]
      if (!vary) return HttpServerResponse.setHeader(response, "vary", "Origin")

      const tokens = vary.split(",").map((s) => s.trim().toLowerCase())
      if (tokens.includes("origin") || tokens.includes("*")) return response

      return HttpServerResponse.setHeader(response, "vary", `${vary}, Origin`)
    }),
  { global: true },
)
