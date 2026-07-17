// ── Live Session Steering Tests ──────────────────────────────────
// Verifies delivery, overlap fan-out, pre-registration queuing, timeout, and
// closure semantics through the subsystem-neutral user steering contract.
// → cyberful/src/subsystem/control.ts — owns active turn registration and delivery.
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import { SubsystemControl } from "./control"

afterEach(() => SubsystemControl.resetForTests())

const accepted = { accepted: true, recipients: 1 } as const

describe("Subsystem live steering", () => {
  test("delivers to the one active sequential turn", async () => {
    const received: string[] = []
    const close = SubsystemControl.open("ses_one")
    const unregister = SubsystemControl.register("ses_one", {
      steer: async (request) => {
        received.push(request.text)
        return accepted
      },
    })

    expect(await SubsystemControl.steer({ sessionID: "ses_one", text: "focus on the authenticated path" })).toEqual(
      accepted,
    )
    expect(received).toEqual(["focus on the authenticated path"])
    unregister()
    close()
  })

  test("broadcasts a steer to every active turn", async () => {
    const received: string[] = []
    const close = SubsystemControl.open("ses_fanout")
    const unregister = ["one", "two", "three"].map((label) =>
      SubsystemControl.register("ses_fanout", {
        steer: async (request) => {
          received.push(`${label}:${request.text}`)
          return accepted
        },
      }),
    )

    expect(await SubsystemControl.steer({ sessionID: "ses_fanout", text: "include the new hostname" })).toEqual({
      accepted: true,
      recipients: 3,
    })
    expect(received.sort()).toEqual([
      "one:include the new hostname",
      "three:include the new hostname",
      "two:include the new hostname",
    ])
    unregister.forEach((remove) => remove())
    close()
  })

  test("holds a steer across a transition and releases it to the successor", async () => {
    const received: string[] = []
    const close = SubsystemControl.open("ses_gap")
    const delivery = SubsystemControl.steer({ sessionID: "ses_gap", text: "recheck the role boundary" })

    SubsystemControl.register("ses_gap", {
      steer: async (request) => {
        received.push(request.text)
        return accepted
      },
    })

    expect(await delivery).toEqual(accepted)
    expect(received).toEqual(["recheck the role boundary"])
    close()
  })

  test("returns an undelivered transition steer when the engagement closes", async () => {
    const close = SubsystemControl.open("ses_done")
    const delivery = SubsystemControl.steer({ sessionID: "ses_done", text: "too late" })
    close()
    expect(await delivery).toEqual({ accepted: false, recipients: 0 })
  })

  test("bounds an unacknowledged active steer instead of waiting forever", async () => {
    const close = SubsystemControl.open("ses_stalled")
    const unregister = SubsystemControl.register("ses_stalled", {
      steer: () => new Promise(() => {}),
    })

    const startedAt = Date.now()
    expect(await SubsystemControl.steer({ sessionID: "ses_stalled", text: "are you there?", timeoutMs: 20 })).toEqual({
      accepted: false,
      recipients: 0,
    })
    expect(Date.now() - startedAt).toBeLessThan(500)

    unregister()
    close()
  })

  test("expires a transition steer before a late successor registers", async () => {
    const received: string[] = []
    const close = SubsystemControl.open("ses_expired_gap")

    expect(
      await SubsystemControl.steer({ sessionID: "ses_expired_gap", text: "stale direction", timeoutMs: 20 }),
    ).toEqual({ accepted: false, recipients: 0 })
    SubsystemControl.register("ses_expired_gap", {
      steer: async (request) => {
        received.push(request.text)
        return accepted
      },
    })

    expect(received).toEqual([])
    close()
  })
})
