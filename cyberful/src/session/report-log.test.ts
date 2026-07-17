// ── Session Report Log Tests ────────────────────────────────────
// Verifies transcript ownership names and proves that a failed journal append
// remains retryable without duplicating the eventual durable user event.
// → cyberful/src/session/report-log.ts — owns transcript path construction.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { Effect, Schema } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { ProjectID } from "@/project/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, PartID, SessionID } from "./schema"
import { MessageV2 } from "./message-v2"
import { create, expertTranscriptFile, pathForSession } from "./report-log"

const location = { directory: "/project", worktree: "/project" }

describe("phase transcript paths", () => {
  test("workflow-scopes short AppSec phase names without renaming Pentest or Ask", () => {
    expect(expertTranscriptFile(location, "ses_1", "verify", "code-audit")).toBe(
      path.join("/project", "logs", "session-logs", "session-ses_1.expert-code-audit-verify.jsonl"),
    )
    expect(expertTranscriptFile(location, "ses_1", "verify", "assessment")).toBe(
      path.join("/project", "logs", "session-logs", "session-ses_1.expert-assessment-verify.jsonl"),
    )
    expect(expertTranscriptFile(location, "ses_1", "verify", "pentest")).toBe(
      path.join("/project", "logs", "session-logs", "session-ses_1.expert-verify.jsonl"),
    )
    expect(expertTranscriptFile(location, "ses_1", "ask-msg", "ask")).toBe(
      path.join("/project", "logs", "session-logs", "session-ses_1.expert-ask-msg.jsonl"),
    )
  })
})

test("a failed journal append can be retried exactly once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cyberful-report-log-"))
  const sessionID = SessionID.make("ses_report_retry")
  const messageID = MessageID.make("msg_report_retry")
  const context = {
    directory: root,
    worktree: root,
    project: {
      id: ProjectID.make("report-retry"),
      worktree: root,
      time: { created: 0, updated: 0 },
    },
  }
  const run = <A>(effect: Effect.Effect<A>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(InstanceRef, context)))
  const journal = create()
  const message: MessageV2.User = {
    id: messageID,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "ask",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
  }
  const part: MessageV2.TextPart = {
    id: PartID.make("prt_report_retry"),
    sessionID,
    messageID,
    type: "text",
    text: "daily user activity",
  }

  try {
    await writeFile(path.join(root, "logs"), "blocks the journal directory")
    await run(journal.message(message))
    await expect(run(journal.part(part))).rejects.toThrow("failed to append session report log")

    await rm(path.join(root, "logs"))
    await run(journal.part(part))
    await run(journal.part(part))

    const file = await run(pathForSession(sessionID))
    const entries = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(line))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      type: "user_message",
      sessionID,
      messageID,
      partID: part.id,
      text: part.text,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
