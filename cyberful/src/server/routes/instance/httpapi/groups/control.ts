// ── Process Control Endpoint Contracts ──────────────────────────
// Declares the root logging route and validates its service, severity, message,
// and optional structured metadata before they reach the server logger.
// → cyberful/src/server/routes/instance/httpapi/handlers/control.ts — writes validated log entries.
// ─────────────────────────────────────────────────────────────────

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const ServiceName = Schema.String.check(Schema.isLengthBetween(1, 128))
const LogMessage = Schema.String.check(Schema.isLengthBetween(1, 16_384))
const ExtraKey = Schema.String.check(Schema.isLengthBetween(1, 128))
const LogExtra = Schema.Record(ExtraKey, Schema.Unknown).check(Schema.isMaxProperties(64))

const LogQuery = Schema.Struct({
  directory: Schema.optional(Schema.String),
})

export const LogInput = Schema.Struct({
  service: ServiceName.annotate({ description: "Service name for the log entry" }),
  level: Schema.Union([
    Schema.Literal("debug"),
    Schema.Literal("info"),
    Schema.Literal("error"),
    Schema.Literal("warn"),
  ]).annotate({ description: "Log level" }),
  message: LogMessage.annotate({ description: "Log message" }),
  extra: Schema.optional(LogExtra).annotate({
    description: "Additional metadata for the log entry",
  }),
})

export const ControlPaths = {
  log: "/log",
} as const

export const ControlApi = HttpApi.make("control").add(
  HttpApiGroup.make("control")
    .add(
      HttpApiEndpoint.post("log", ControlPaths.log, {
        query: LogQuery,
        payload: LogInput,
        success: described(Schema.Boolean, "Log entry written successfully"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "app.log",
          summary: "Write log",
          description: "Write a log entry to the server logs with specified level and metadata.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "control", description: "Control plane routes." })),
)
