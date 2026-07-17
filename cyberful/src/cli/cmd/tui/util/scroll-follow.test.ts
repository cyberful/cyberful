// ── Idle Scroll Following Tests ─────────────────────────────────
// Protects automatic bottom following for live transcripts while preserving a
//   full idle window after every observed reader movement.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { IdleScrollFollow, SCROLL_FOLLOW_IDLE_MS } from "./scroll-follow"

const activeDetached = (now: number, scrollTop = 100) => ({
  active: true,
  detached: true,
  now,
  scrollTop,
})

describe("idle scroll following", () => {
  test("returns a detached live transcript to the bottom after sixty idle seconds", () => {
    const follow = new IdleScrollFollow()

    expect(follow.observe(activeDetached(0))).toBeFalse()
    expect(follow.observe(activeDetached(SCROLL_FOLLOW_IDLE_MS - 1))).toBeFalse()
    expect(follow.observe(activeDetached(SCROLL_FOLLOW_IDLE_MS))).toBeTrue()
  })

  test("restarts the idle window whenever the reader moves", () => {
    const follow = new IdleScrollFollow()

    expect(follow.observe(activeDetached(0))).toBeFalse()
    expect(follow.observe(activeDetached(50_000, 80))).toBeFalse()
    expect(follow.observe(activeDetached(109_999, 80))).toBeFalse()
    expect(follow.observe(activeDetached(110_000, 80))).toBeTrue()
  })

  test("does not carry an idle deadline across attached or inactive views", () => {
    const follow = new IdleScrollFollow()

    expect(follow.observe(activeDetached(0))).toBeFalse()
    expect(follow.observe({ ...activeDetached(59_000), detached: false })).toBeFalse()
    expect(follow.observe(activeDetached(60_000))).toBeFalse()
    expect(follow.observe({ ...activeDetached(119_000), active: false })).toBeFalse()
    expect(follow.observe(activeDetached(120_000))).toBeFalse()
    expect(follow.observe(activeDetached(180_000))).toBeTrue()
  })
})
