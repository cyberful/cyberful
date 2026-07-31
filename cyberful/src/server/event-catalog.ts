// ── Public Event Schema Catalog ──────────────────────────────────
// Loads every repository-owned event definition, seals the canonical registry,
// and returns the complete live and transactional payload schemas used by
// HTTP and generated-client contracts.
// → cyberful/src/server/routes/instance/httpapi/api.ts — publishes project event schemas.
// → cyberful/src/server/routes/instance/httpapi/groups/global.ts — publishes global event schemas.
// ─────────────────────────────────────────────────────────────────

import "@/bus"
import "@/cli/cmd/tui/event"
import "@/command"
import "@/file"
import "@/file/watcher"
import "@/project/project"
import "@/project/vcs"
import "@/pty"
import "@/question"
import "@/server/event"
import "@/session/event"
import "@/session/finding"
import "@/session/hypothesis"
import "@/session/message-v2"
import "@/session/session"
import "@/session/status"
import "@/session/todo"
import "@/session/variable"
import { Event } from "@/event"
import { EventProjection } from "@/event-projection"

export function payloadSchemas() {
  Event.freezeDefinitions()
  return {
    events: Event.effectPayloads(),
    sync: EventProjection.effectPayloads(),
  }
}
