// ── Instance Capability Endpoint Contracts ──────────────────────
// Declares directory-scoped routes for agents, commands, formatting, skills,
// repository state, runtime readiness, and instance capability discovery.
// → cyberful/src/server/routes/instance/httpapi/handlers/instance.ts — serves these capabilities.
// → cyberful/src/subsystem/status.ts — supplies the runtime readiness contract values.
// ─────────────────────────────────────────────────────────────────

import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Format } from "@/format"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  DirectoryRoutingMiddleware,
  DirectoryRoutingQuery,
  DirectoryRoutingQueryFields,
} from "../middleware/directory-routing"
import { described } from "./metadata"

const PathInfo = Schema.Struct({
  home: Schema.String,
  state: Schema.String,
  config: Schema.String,
  worktree: Schema.String,
  directory: Schema.String,
}).annotate({ identifier: "Path" })

export const RuntimeStatus = Schema.Struct({
  primary: Schema.Struct({
    name: Schema.String,
    model: Schema.String,
    version: Schema.optional(Schema.String),
    status: Schema.Literals(["available", "degraded", "unavailable"]),
  }),
  fallback: Schema.Struct({
    model: Schema.optional(Schema.String),
    status: Schema.Literals(["available", "disabled", "unavailable"]),
  }),
}).annotate({ identifier: "RuntimeStatus" })

export const VcsDiffQuery = Schema.Struct({
  ...DirectoryRoutingQueryFields,
  mode: Vcs.Mode,
  context: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

export class ApiVcsApplyError extends Schema.ErrorClass<ApiVcsApplyError>("VcsApplyError")(
  {
    name: Schema.Literal("VcsApplyError"),
    data: Schema.Struct({
      message: Schema.String,
      reason: Schema.Literals(["non-git", "not-clean"]),
    }),
  },
  { httpApiStatus: 400 },
) {}

export const InstancePaths = {
  dispose: "/instance/dispose",
  path: "/path",
  vcs: "/vcs",
  vcsStatus: "/vcs/status",
  vcsDiff: "/vcs/diff",
  vcsDiffRaw: "/vcs/diff/raw",
  vcsApply: "/vcs/apply",
  command: "/command",
  agent: "/agent",
  skill: "/skill",
  formatter: "/formatter",
  runtimeStatus: "/runtime/status",
} as const

export const InstanceApi = HttpApi.make("instance")
  .add(
    HttpApiGroup.make("instance")
      .add(
        HttpApiEndpoint.post("dispose", InstancePaths.dispose, {
          query: DirectoryRoutingQuery,
          success: described(Schema.Boolean, "Instance disposed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "instance.dispose",
            summary: "Dispose instance",
            description: "Clean up and dispose the current Cyberful instance, releasing all resources.",
          }),
        ),
        HttpApiEndpoint.get("path", InstancePaths.path, {
          query: DirectoryRoutingQuery,
          success: PathInfo,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "path.get",
            summary: "Get paths",
            description:
              "Retrieve the current working directory and related path information for the Cyberful instance.",
          }),
        ),
        HttpApiEndpoint.get("vcs", InstancePaths.vcs, {
          query: DirectoryRoutingQuery,
          success: described(Vcs.Info, "VCS info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.get",
            summary: "Get VCS info",
            description:
              "Retrieve version control system (VCS) information for the current project, such as git branch.",
          }),
        ),
        HttpApiEndpoint.get("vcsStatus", InstancePaths.vcsStatus, {
          query: DirectoryRoutingQuery,
          success: described(Schema.Array(Vcs.FileStatus), "VCS status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.status",
            summary: "Get VCS status",
            description: "Retrieve changed files in the current working tree without patches.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiff", InstancePaths.vcsDiff, {
          query: VcsDiffQuery,
          success: described(Schema.Array(Vcs.FileDiff), "VCS diff"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff",
            summary: "Get VCS diff",
            description: "Retrieve the current git diff for the working tree or against the default branch.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiffRaw", InstancePaths.vcsDiffRaw, {
          query: DirectoryRoutingQuery,
          success: described(
            Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/x-diff; charset=utf-8" })),
            "Raw VCS diff",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff.raw",
            summary: "Get raw VCS diff",
            description: "Retrieve a raw patch for current uncommitted changes.",
          }),
        ),
        HttpApiEndpoint.post("vcsApply", InstancePaths.vcsApply, {
          query: DirectoryRoutingQuery,
          payload: Vcs.ApplyInput,
          success: described(Vcs.ApplyResult, "VCS patch applied"),
          error: ApiVcsApplyError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.apply",
            summary: "Apply VCS patch",
            description: "Apply a raw patch to the current working tree.",
          }),
        ),
        HttpApiEndpoint.get("command", InstancePaths.command, {
          query: DirectoryRoutingQuery,
          success: described(Schema.Array(Command.Info), "List of commands"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "command.list",
            summary: "List commands",
            description: "Get a list of all available commands in the Cyberful system.",
          }),
        ),
        HttpApiEndpoint.get("agent", InstancePaths.agent, {
          query: DirectoryRoutingQuery,
          success: described(Schema.Array(Agent.Info), "List of agents"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.agents",
            summary: "List agents",
            description: "Get a list of all available AI agents in the Cyberful system.",
          }),
        ),
        HttpApiEndpoint.get("skill", InstancePaths.skill, {
          query: DirectoryRoutingQuery,
          success: described(Schema.Array(Skill.Info), "List of skills"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.skills",
            summary: "List skills",
            description: "Get a list of all available skills in the Cyberful system.",
          }),
        ),
        HttpApiEndpoint.get("formatter", InstancePaths.formatter, {
          query: DirectoryRoutingQuery,
          success: described(Schema.Array(Format.Status), "Formatter status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "formatter.status",
            summary: "Get formatter status",
            description: "Get formatter status",
          }),
        ),
        HttpApiEndpoint.get("runtimeStatus", InstancePaths.runtimeStatus, {
          query: DirectoryRoutingQuery,
          success: described(RuntimeStatus, "Subsystem and fallback readiness"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "runtime.status",
            summary: "Get runtime status",
            description: "Probe the active subsystem and optional local fallback server.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "instance",
          description: "Experimental HttpApi instance read routes.",
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
