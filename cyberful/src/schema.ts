// ── Shared Runtime Schema Primitives ─────────────────────────────
// Provides branded paths, numeric constraints, omission semantics, deep mutable
// projection, and nominal schema helpers used across domain boundaries.
// → cyberful/src/session/schema.ts — composes these primitives into persisted contracts.
// → cyberful/src/config/config.ts — uses deep mutable projections after validation.
// ─────────────────────────────────────────────────────────────────

import { Option, Schema, SchemaGetter } from "effect"

export const AbsolutePath = Schema.String.pipe(Schema.brand("AbsolutePath"))
export type AbsolutePath = typeof AbsolutePath.Type

export const RelativePath = Schema.String.pipe(Schema.brand("RelativePath"))
export type RelativePath = typeof RelativePath.Type

/**
 * Integer greater than zero.
 */
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

/**
 * Integer greater than or equal to zero.
 */
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * Optional public JSON field that can hold explicit `undefined` on the type
 * side but encodes it as an omitted key, matching legacy `JSON.stringify`.
 */
export const optionalOmitUndefined = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(schema).pipe(
    Schema.decodeTo(Schema.optional(schema), {
      decode: SchemaGetter.passthrough({ strict: false }),
      encode: SchemaGetter.transformOptional(Option.filter((value) => value !== undefined)),
    }),
  )

// ── Deep Mutable Preserves Unknown, Brands, And Tuples ───────────
// Effect's upstream helper currently maps unknown through keyof unknown and
// collapses it to an empty object. The explicit object gate keeps unknown intact.
// Primitive bailout prevents branded scalar prototypes from being traversed,
// while the tuple branch runs before the general array branch so fixed plugin
// specifications do not widen into unbounded mutable arrays.
// ─────────────────────────────────────────────────────────────────
export type DeepMutable<T> = T extends string | number | boolean | bigint | symbol | Function
  ? T
  : T extends readonly [unknown, ...unknown[]]
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T extends readonly (infer U)[]
      ? DeepMutable<U>[]
      : T extends object
        ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
        : T

/**
 * Attach static methods to a schema object. Designed to be used with `.pipe()`:
 *
 * @example
 *   export const Foo = fooSchema.pipe(
 *     withStatics((schema) => ({
 *       zero: schema.make(0),
 *       from: Schema.decodeUnknownOption(schema),
 *     }))
 *   )
 */
export const withStatics =
  <S extends object, M extends Record<string, unknown>>(methods: (schema: S) => M) =>
  (schema: S): S & M =>
    Object.assign(schema, methods(schema))

// ── Newtypes Remain Runtime Schemas ──────────────────────────────
// A nominal scalar wrapper must be usable directly by Schema decoding while
// preserving the concrete Self type at every inferred field. Overriding the
// opaque schema's type-level maker repairs the structural equivalence TypeScript
// cannot infer between the class value and its branded scalar. The remaining
// assertions are confined to this constructor and introduce no runtime coercion.
// ─────────────────────────────────────────────────────────────────
export function Newtype<Self>() {
  return <const Tag extends string, S extends Schema.Top>(_tag: Tag, schema: S) => {
    abstract class Base {
      declare readonly _newtype: Tag

      static make(value: Schema.Schema.Type<S>): Self {
        return value as unknown as Self
      }
    }

    Object.setPrototypeOf(Base, schema)

    return Base as unknown as (abstract new (_: never) => { readonly _newtype: Tag }) & {
      readonly make: (value: Schema.Schema.Type<S>) => Self
    } & Omit<Schema.Opaque<Self, S, {}>, "make" | "~type.make"> & {
        readonly "~type.make": Self
      }
  }
}
