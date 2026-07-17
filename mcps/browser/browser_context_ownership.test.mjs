// ── Browser Context Ownership Contract ─────────────────────────────
// Verifies that normal shutdown closes locally owned contexts without ever
// closing the shared CDP context used by sibling scouts. In own-tab mode only
// the tab created by this process is released, preserving the shared session.
// → mcps/browser/browser_context_ownership.mjs — implements the boundary.
// ───────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { releaseBrowserContext } from "./browser_context_ownership.mjs"

function browserHandles() {
  const calls = { context: 0, page: 0 }
  return {
    calls,
    context: {
      close: async () => {
        calls.context += 1
      },
    },
    pinnedPage: {
      close: async () => {
        calls.page += 1
      },
      isClosed: () => false,
    },
  }
}

describe("browser context ownership", () => {
  test("closes contexts created by this process", async () => {
    for (const ownership of ["persistent", "cdp-created"]) {
      const handles = browserHandles()
      await releaseBrowserContext({ ...handles, ownership, ownTab: true })
      expect(handles.calls).toEqual({ context: 1, page: 0 })
    }
  })

  test("preserves a shared context and closes only its owned tab", async () => {
    const handles = browserHandles()
    await releaseBrowserContext({ ...handles, ownership: "cdp-shared", ownTab: true })
    expect(handles.calls).toEqual({ context: 0, page: 1 })
  })

  test("does not mutate a shared context without an owned tab", async () => {
    const handles = browserHandles()
    await releaseBrowserContext({ ...handles, ownership: "cdp-shared", ownTab: false })
    expect(handles.calls).toEqual({ context: 0, page: 0 })
  })
})
