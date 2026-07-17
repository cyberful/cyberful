// ── Instance Event Stream Contract ──────────────────────────────
// Declares the directory-routed server-sent event endpoint used by clients to
// observe live instance bus activity as an event-stream response.
// → cyberful/src/server/routes/instance/httpapi/handlers/event.ts — publishes the event stream.
// ─────────────────────────────────────────────────────────────────

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { DirectoryRoutingQuery } from "../middleware/directory-routing"

export const EventPaths = {
  event: "/event",
} as const

export const EventApi = HttpApi.make("event").add(
  HttpApiGroup.make("event")
    .add(
      HttpApiEndpoint.get("subscribe", EventPaths.event, {
        query: DirectoryRoutingQuery,
        success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "event.subscribe",
          summary: "Subscribe to events",
          description: "Get events",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "event", description: "Instance event stream route." })),
)
