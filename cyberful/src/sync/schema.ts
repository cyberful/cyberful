// ── Projected Event Identifier Schema ────────────────────────────
// Brands ordered event identifiers used by transactional projectors and live bus publication.
// → cyberful/src/sync/index.ts — creates projected events with this identifier contract.
// ─────────────────────────────────────────────────────────────────

import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { withStatics } from "@/schema"

export const EventID = Schema.String.check(Schema.isStartsWith("evt")).pipe(
  Schema.brand("EventID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("event", id)),
  })),
)
