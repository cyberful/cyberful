// ── Browser Context Teardown Boundary ───────────────────────────────
// Releases browser resources according to who created their context.
// Local persistent and CDP-created contexts are closed completely, while an
// attached shared context remains host-owned and can lose only this process's
// owned tabs. This protects sibling AgentRuns and the browser hub during shutdown.
// → mcps/browser/browser_mcp.mjs — captures ownership and invokes teardown.
// ────────────────────────────────────────────────────────────────────

const OWNED_CONTEXTS = new Set(["persistent", "cdp-created"])

export async function releaseBrowserContext({ context, ownership, ownTab, ownedPages = [] }) {
  if (ownership === "none") return
  if (ownership === "cdp-shared") {
    if (ownTab) {
      await Promise.allSettled(ownedPages.map((page) => (page.isClosed() ? Promise.resolve() : page.close())))
    }
    return
  }
  if (!OWNED_CONTEXTS.has(ownership)) throw new Error(`unknown browser context ownership: ${ownership}`)
  if (context) await context.close()
}
