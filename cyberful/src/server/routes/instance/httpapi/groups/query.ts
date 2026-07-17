// ── Boolean Query Parameter Codec ───────────────────────────────
// Normalizes the accepted string representation of HTTP boolean query values
// while documenting both boolean and string forms in generated OpenAPI output.
// → cyberful/src/server/routes/instance/httpapi/public.ts — applies the public schema override.
// ─────────────────────────────────────────────────────────────────

import { Schema, SchemaGetter } from "effect"

export const QueryBoolean = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value) => (value ? "true" : "false")),
  }),
)

export const QueryBooleanOpenApi = {
  anyOf: [{ type: "boolean" }, { type: "string", enum: ["true", "false"] }],
}
