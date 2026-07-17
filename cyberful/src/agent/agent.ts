// ── Workflow-Scoped Persona Catalog ──────────────────────────────
// Exposes configured primary personas to the API and terminal UI while
// preserving semantic display names and collision-free workflow ownership.
// → cyberful/src/config/agent.ts — discovers and scopes persona files.
// ─────────────────────────────────────────────────────────────────

import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { serviceUse } from "@/effect/service-use"
import { type DeepMutable } from "@/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { pipe, sortBy, values } from "remeda"

// ── Personas Are Product Policy, Not Model Selection ─────────────
// Markdown discovery owns persona identity, presentation, and workflow scope.
// This service projects only primary personas into the UI and session API and
// never turns those records into provider or model configuration. Keeping that
// boundary explicit prevents catalog metadata from becoming a second executor
// selection path beside the host-owned Codex runtime.
// ─────────────────────────────────────────────────────────────────
export const Info = Schema.Struct({
  name: Schema.String,
  workflow: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  mode: Schema.Literal("primary"),
  hidden: Schema.optional(Schema.Boolean),
  color: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
}

type State = Interface

export class Service extends Context.Service<Service, Interface>()("@cyberful/Agent") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* () {
        const cfg = yield* config.get()
        const agents = Object.fromEntries(
          Object.entries(cfg.agent ?? {}).map(([catalogID, persona]) => [
            catalogID,
            {
              name: persona.name,
              workflow: persona.workflow,
              description: persona.description,
              mode: "primary" as const,
              hidden: persona.hidden,
              color: persona.color,
              prompt: persona.prompt,
            } satisfies Info,
          ]),
        )

        const get = Effect.fnUntraced(function* (agent: string) {
          const exact = agents[agent]
          if (exact) return exact
          const semanticMatches = Object.values(agents).filter((candidate) => candidate.name === agent)
          return semanticMatches.length === 1 ? semanticMatches[0] : undefined
        })

        const list = Effect.fnUntraced(function* () {
          return pipe(
            agents,
            values(),
            sortBy(
              [(agent) => `${agent.workflow ? `${agent.workflow}/` : ""}${agent.name}` === cfg.default_agent, "desc"],
              [(agent) => agent.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          if (cfg.default_agent) {
            const agent = agents[cfg.default_agent]
            if (!agent) throw new Error(`default agent "${cfg.default_agent}" not found`)
            if (agent.hidden === true) throw new Error(`default agent "${cfg.default_agent}" is hidden`)
            return agent
          }
          const visible = Object.values(agents).find((agent) => agent.hidden !== true)
          if (!visible) throw new Error("no visible phase persona found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return { get, list, defaultInfo, defaultAgent } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (current) => current.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (current) => current.list())
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (current) => current.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (current) => current.defaultAgent())
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as Agent from "./agent"
