// ── Control-Plane HTTP API Composition ──────────────────────────
// Combines root, instance, event, and PTY endpoint groups with their shared
// middleware and registers every event payload in the public API schema.
// → cyberful/src/server/routes/instance/httpapi/server.ts — binds handlers to these contracts.
// ─────────────────────────────────────────────────────────────────

import { Schema } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { payloadSchemas } from "@/server/event-catalog"
import { ConfigApi } from "./groups/config"
import { ControlApi } from "./groups/control"
import { EventApi } from "./groups/event"
import { FileApi } from "./groups/file"
import { GlobalApi } from "./groups/global"
import { InstanceApi } from "./groups/instance"
import { ProjectApi } from "./groups/project"
import { PtyApi, PtyConnectApi } from "./groups/pty"
import { QuestionApi } from "./groups/question"
import { SessionApi } from "./groups/session"
import { TuiApi } from "./groups/tui"
import { Authorization } from "./middleware/authorization"
import { SchemaErrorMiddleware } from "./middleware/schema-error"

const payloads = payloadSchemas()
const EventSchema = Schema.Union(payloads.events).annotate({ identifier: "Event" })

export const RootHttpApi = HttpApi.make("cyberful-root")
  .addHttpApi(ControlApi)
  .addHttpApi(GlobalApi)
  .middleware(SchemaErrorMiddleware)
  .middleware(Authorization)

export const InstanceHttpApi = HttpApi.make("cyberful-instance")
  .addHttpApi(ConfigApi)
  .addHttpApi(FileApi)
  .addHttpApi(InstanceApi)
  .addHttpApi(ProjectApi)
  .addHttpApi(PtyApi)
  .addHttpApi(QuestionApi)
  .addHttpApi(SessionApi)
  .addHttpApi(TuiApi)
  .middleware(SchemaErrorMiddleware)

export const CyberfulHttpApi = HttpApi.make("cyberful")
  .addHttpApi(RootHttpApi)
  .addHttpApi(EventApi)
  .addHttpApi(InstanceHttpApi)
  .addHttpApi(PtyConnectApi)
  .annotate(HttpApi.AdditionalSchemas, [EventSchema, ...payloads.sync])

export type RootHttpApiType = typeof RootHttpApi
export type InstanceHttpApiType = typeof InstanceHttpApi
