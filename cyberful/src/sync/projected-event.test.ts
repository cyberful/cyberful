// ── Projected Event Schema Boundary Tests ───────────────────────
// Verifies that transformed optional properties survive the post-commit live
// publication boundary in their canonical typed representation.
// → cyberful/src/sync/index.ts — owns projected event canonicalization.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { canonicalProperties } from "."

test("canonicalizes already-decoded optional properties before live publication", async () => {
  const properties = Schema.Struct({
    required: Schema.String,
    present: Schema.OptionFromOptionalKey(Schema.String),
    absent: Schema.OptionFromOptionalKey(Schema.String),
  })
  const typed = Schema.decodeUnknownSync(properties)({ required: "session", present: "goal" })

  expect(() => Schema.decodeUnknownSync(properties)(typed)).toThrow()
  const canonical = await Effect.runPromise(canonicalProperties(properties, typed))

  expect(canonical).toEqual(typed)
  expect(Schema.encodeUnknownSync(properties)(canonical)).toEqual({ required: "session", present: "goal" })
})
