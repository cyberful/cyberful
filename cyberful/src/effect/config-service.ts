// ── Typed Effect Configuration Services ────────────────────────────
// Generates Context service classes whose production layers parse declared
// Effect configuration while tests can provide already validated values.
// → cyberful/src/effect/runtime-flags.ts — defines a concrete generated service.
// ────────────────────────────────────────────────────────────────────

import { Config, Context, Effect, Layer } from "effect"

type ConfigMap = Record<string, Config.Config<unknown>>

/**
 * The service shape inferred from an object of Effect `Config` definitions.
 */
export type Shape<Fields extends ConfigMap> = {
  readonly [Key in keyof Fields]: Config.Success<Fields[Key]>
}

// ── Parsed Config Records Retain Their Declared Keys ────────────────
// Config.all has one conditional type covering records, arrays, and iterables,
// so TypeScript cannot reduce its result for a generic record constraint. The
// parser already validates each field's value; this guard proves that its runtime
// record has exactly the declared string keys before it enters the service.
// ─────────────────────────────────────────────────────────────────────

function hasDeclaredShape<Fields extends ConfigMap>(fields: Fields, value: unknown): value is Shape<Fields> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const expected = Object.keys(fields)
  const actual = Object.keys(value)
  return expected.length === actual.length && expected.every((key) => Object.hasOwn(value, key))
}

/**
 * A Context service class with generated layers for config-backed services.
 */
export type ServiceClass<Self, Id extends string, Service> = Context.ServiceClass<Self, Id, Service> & {
  /** Provide already-parsed config, useful in tests. */
  readonly layer: (input: Service) => Layer.Layer<Self>
  /** Parse config once from the active Effect ConfigProvider and provide the service. */
  readonly defaultLayer: Layer.Layer<Self, Config.ConfigError>
}

/**
 * Create a Context service whose implementation is derived from Effect `Config`.
 *
 * This keeps Effect `Config` as the source of truth for env names, defaults, and
 * validation while generating a typed service plus convenient production/test
 * layers.
 *
 * ```ts
 * class ServerAuthConfig extends ConfigService.Service<ServerAuthConfig>()(
 *   "@cyberful/ServerAuthConfig",
 *   {
 *     password: Config.string("CYBERFUL_SERVER_PASSWORD").pipe(Config.option),
 *     username: Config.string("CYBERFUL_SERVER_USERNAME").pipe(Config.withDefault("cyberful")),
 *   },
 * ) {}
 *
 * const live = ServerAuthConfig.defaultLayer
 * const test = ServerAuthConfig.layer({ password: Option.some("secret"), username: "kit" })
 * ```
 */
export const Service =
  <Self>() =>
  <const Id extends string, const Fields extends ConfigMap>(id: Id, fields: Fields) => {
    class ConfigTag extends Context.Service<Self, Shape<Fields>>()(id) {
      static layer(input: Shape<Fields>) {
        return Layer.succeed(this, this.of(input))
      }

      static get defaultLayer() {
        const tag = this
        return Layer.effect(
          tag,
          Effect.gen(function* () {
            const config = yield* Config.all(fields)
            if (!hasDeclaredShape(fields, config)) {
              return yield* Effect.die(new Error(`Config parser changed the declared shape for ${id}`))
            }
            return tag.of(config)
          }),
        )
      }
    }

    return ConfigTag
  }

export * as ConfigService from "./config-service"
