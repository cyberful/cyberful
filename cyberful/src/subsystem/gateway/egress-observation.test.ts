// ── Passive Egress Observation Tests ────────────────────────────
// Verifies URL redaction and degraded route evidence without exposing queries,
// credentials, or treating an unseen destination as an execution failure.
// → cyberful/src/subsystem/gateway/egress-observation.ts — derives metadata.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { EgressObservation } from "./egress-observation"

describe("passive egress observation", () => {
  test("keeps host and path family while dropping secrets and identifiers", () => {
    expect(
      EgressObservation.observe(
        "zap_http_request",
        { url: "https://user:secret@api.example.test/v1/accounts/123456?token=secret", method: "post" },
        { content: [{ type: "text", text: "ok" }] },
      ),
    ).toEqual({
      egress_host: "api.example.test",
      egress_path_family: "/v1/accounts/:id",
      egress_method: "POST",
      egress_http_status: undefined,
      egress_deadline_ms: undefined,
      egress_route: "zap",
      egress_observability: "inferred",
    })
  })

  test("preserves a degraded direct route when shell metadata is unavailable", () => {
    expect(EgressObservation.observe("shell", { command: "python3 poc/probe.py" }, { content: [] })).toEqual({
      egress_host: undefined,
      egress_path_family: undefined,
      egress_method: undefined,
      egress_http_status: undefined,
      egress_deadline_ms: undefined,
      egress_route: "cyberful-os/docker-direct",
      egress_observability: "degraded",
    })
  })

  test("preserves redaction sentinels supplied by the executing shell runtime", () => {
    expect(
      EgressObservation.observe("shell", {}, {
        content: [],
        _meta: {
          "cyberful.dev/egress": {
            host: "api.example.test",
            path_family: "/v1/accounts/:id",
            status: 403,
            route: "cyberful-os/docker-direct",
            observability: "observed",
          },
        },
      }),
    ).toMatchObject({
      egress_path_family: "/v1/accounts/:id",
      egress_http_status: 403,
      egress_observability: "observed",
    })
  })

  test("distinguishes declared local-only shell work from missing network telemetry", () => {
    expect(
      EgressObservation.observe("shell", {}, {
        content: [],
        _meta: {
          "cyberful.dev/egress": {
            route: "cyberful-os/docker-direct",
            observability: "not_applicable",
            destination_changed: false,
          },
        },
      }),
    ).toMatchObject({
      egress_host: undefined,
      egress_route: "cyberful-os/docker-direct",
      egress_observability: "not_applicable",
    })
  })

  test("collapses personal and opaque path segments instead of persisting them", () => {
    expect(EgressObservation.pathFamily("/users/alice@example.test/sessions/opaqueBearerValue12345")).toBe(
      "/users/:id/sessions/:id",
    )
  })
})
