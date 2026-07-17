// ── Configuration Endpoint Contracts ────────────────────────────
// Declares the authenticated read and update routes for the configuration of a
// directory-routed instance, including their public request and response schemas.
// → cyberful/src/server/routes/instance/httpapi/handlers/config.ts — implements these endpoints.
// ─────────────────────────────────────────────────────────────────

import { Config } from "@/config/config"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { DirectoryRoutingMiddleware, DirectoryRoutingQuery } from "../middleware/directory-routing"
import { described } from "./metadata"

const root = "/config"

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: DirectoryRoutingQuery,
          success: described(Config.Info, "Get config info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.get",
            summary: "Get configuration",
            description: "Retrieve the current Cyberful configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          query: DirectoryRoutingQuery,
          payload: Config.Info,
          success: described(Config.Info, "Successfully updated config"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.update",
            summary: "Update configuration",
            description: "Update Cyberful configuration settings and preferences.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "Experimental HttpApi config routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(DirectoryRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "cyberful experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
