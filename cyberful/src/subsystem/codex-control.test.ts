// ── Codex Steering Adapter Test ──────────────────────────────────
// Verifies that a live user steer reaches the active Codex turn and its native
// acknowledgement is translated into the subsystem-neutral response contract.
// → cyberful/src/subsystem/codex-control.ts — implements the tested edge adapter.
// ─────────────────────────────────────────────────────────────────

import { afterEach, expect, test } from "bun:test"
import { SubsystemCodexControl } from "./codex-control"
import { SubsystemControl } from "./control"

afterEach(() => SubsystemControl.resetForTests())

test("the Codex adapter translates turn/steer acknowledgement into the generic control API", async () => {
  const received: string[] = []
  const close = SubsystemControl.open("ses_codex")
  const unregister = SubsystemCodexControl.register("ses_codex", {
    steer: async (text) => {
      received.push(text)
      return true
    },
  })

  expect(await SubsystemControl.steer({ sessionID: "ses_codex", text: "inspect the admin route" })).toEqual({
    accepted: true,
    recipients: 1,
  })
  expect(received).toEqual(["inspect the admin route"])

  unregister()
  close()
})
