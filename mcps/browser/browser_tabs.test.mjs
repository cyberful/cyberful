// ── AgentRun Browser Tab Ownership Contract ─────────────────────────
// Verifies private listing, selection, closure, popup inheritance, and stable
// identifiers without requiring Chromium. Foreign ids are indistinguishable
// from stale ids and closing the last tab leaves lazy recreation to the caller.
// → mcps/browser/browser_tabs.mjs — implements the ownership registry.
// ────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { OwnedBrowserTabs } from "./browser_tabs.mjs"

class FakePage extends EventEmitter {
  #closed = false

  constructor(id) {
    super()
    this.id = id
  }

  isClosed() {
    return this.#closed
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    this.emit("close")
  }
}

function registry() {
  return new OwnedBrowserTabs({
    identify: async (page) => page.id,
    onOwn: () => {},
    onError: (_operation, error) => {
      throw error
    },
  })
}

describe("AgentRun-owned browser tabs", () => {
  test("lists, selects, and closes only admitted pages", async () => {
    const tabs = registry()
    const first = new FakePage("target-1")
    const second = new FakePage("target-2")
    await tabs.own(first)
    await tabs.own(second)

    expect(tabs.entries().map(({ id, active }) => ({ id, active }))).toEqual([
      { id: "target-1", active: false },
      { id: "target-2", active: true },
    ])
    expect(tabs.select("target-1")).toBe(first)
    expect(() => tabs.select("foreign-target")).toThrow("does not exist")

    await tabs.close("target-1")
    await tabs.close("target-2")
    expect(tabs.active()).toBeNull()
    expect(tabs.entries()).toEqual([])
  })

  test("a popup inherits ownership and becomes active", async () => {
    const tabs = registry()
    const opener = new FakePage("target-opener")
    const popup = new FakePage("target-popup")
    await tabs.own(opener)
    opener.emit("popup", popup)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(tabs.id(popup)).toBe("target-popup")
    expect(tabs.active()).toBe(popup)
  })

  test("detaching returns every owned page without closing it", async () => {
    const tabs = registry()
    const first = new FakePage("target-1")
    const second = new FakePage("target-2")
    await tabs.own(first)
    await tabs.own(second)

    expect(tabs.detach()).toEqual([first, second])
    expect(first.isClosed()).toBe(false)
    expect(second.isClosed()).toBe(false)
    expect(tabs.entries()).toEqual([])
  })
})
