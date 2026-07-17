// ── Question Identifier Schema ───────────────────────────────────
// Brands and creates ordered question IDs shared by pending state and bus events.
// → cyberful/src/question/index.ts — owns the request lifecycle keyed by these IDs.
// ─────────────────────────────────────────────────────────────────

import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { Newtype } from "@/schema"

export class QuestionID extends Newtype<QuestionID>()("QuestionID", Schema.String.check(Schema.isStartsWith("que"))) {
  static ascending(id?: string): QuestionID {
    return this.make(Identifier.ascending("question", id))
  }
}
