// ── Effect Runtime Feature Flags ───────────────────────────────────
// Parses process feature switches once per layer and supports narrowly scoped
// overrides for tests and alternate application runtimes.
// → cyberful/src/effect/config-service.ts — generates the typed config service.
// ────────────────────────────────────────────────────────────────────

import { Config, ConfigProvider, Context, Effect, Layer } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const experimental = bool("CYBERFUL_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: bool(name) }).pipe(Config.map((flags) => flags.experimental || flags.enabled))

export class Service extends ConfigService.Service<Service>()("@cyberful/RuntimeFlags", {
  disableChannelDb: bool("CYBERFUL_DISABLE_CHANNEL_DB"),
  disableExternalSkills: bool("CYBERFUL_DISABLE_EXTERNAL_SKILLS"),
  skipMigrations: bool("CYBERFUL_SKIP_MIGRATIONS"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("CYBERFUL_DISABLE_CLAUDE_CODE"),
    direct: bool("CYBERFUL_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("CYBERFUL_DISABLE_CLAUDE_CODE"),
    direct: bool("CYBERFUL_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  experimentalScout: enabledByExperimental("CYBERFUL_EXPERIMENTAL_SCOUT"),
  experimentalOxfmt: enabledByExperimental("CYBERFUL_EXPERIMENTAL_OXFMT"),
  experimentalEventSystem: enabledByExperimental("CYBERFUL_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalIconDiscovery: enabledByExperimental("CYBERFUL_EXPERIMENTAL_ICON_DISCOVERY"),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.defaultLayer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const defaultLayer = Service.defaultLayer.pipe(Layer.orDie)

export * as RuntimeFlags from "./runtime-flags"
