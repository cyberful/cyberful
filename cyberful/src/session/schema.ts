// ── Session Entity Identifiers ──────────────────────────────────────────
// Validates and brands sortable identifiers for sessions, messages, and parts.
// → cyberful/src/session/session.sql.ts — persists these branded identifiers.
// ────────────────────────────────────────────────────────────────────────

import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { withStatics } from "@/schema"

export const SessionID = Schema.String.check(Schema.isStartsWith("ses")).pipe(
  Schema.brand("SessionID"),
  withStatics((schema) => ({
    descending: (id?: string) => schema.make(Identifier.descending("session", id)),
  })),
)
export type SessionID = Schema.Schema.Type<typeof SessionID>

export const MessageID = Schema.String.check(Schema.isStartsWith("msg")).pipe(
  Schema.brand("MessageID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("message", id)),
  })),
)

export type MessageID = Schema.Schema.Type<typeof MessageID>

export const PartID = Schema.String.check(Schema.isStartsWith("prt")).pipe(
  Schema.brand("PartID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("part", id)),
  })),
)

export type PartID = Schema.Schema.Type<typeof PartID>
