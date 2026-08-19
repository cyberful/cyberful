// ── AgentRun-Owned Browser Tabs ─────────────────────────────────────
// Tracks only pages created by one browser controller. Stable opaque ids are
// the public tab handles; pages discovered through the shared context are never
// admitted. Popups inherit ownership from their opener and become active.
// → mcps/browser/browser_mcp.mjs — supplies CDP identity and page instrumentation.
// ────────────────────────────────────────────────────────────────────

export class OwnedBrowserTabs {
  _activeID = null
  _identify
  _onError
  _onOwn
  _pending = new WeakMap()
  _pageIDs = new WeakMap()
  _tabs = new Map()

  constructor({ identify, onOwn = () => {}, onError = () => {} }) {
    this._identify = identify
    this._onOwn = onOwn
    this._onError = onError
  }

  async own(page, { activate = true } = {}) {
    const existing = this._pageIDs.get(page)
    if (existing) {
      if (activate) this._activeID = existing
      return existing
    }
    const pending = this._pending.get(page)
    if (pending) {
      const id = await pending
      if (activate) this._activeID = id
      return id
    }

    const ownership = this._admit(page, activate)
    this._pending.set(page, ownership)
    try {
      return await ownership
    } finally {
      this._pending.delete(page)
    }
  }

  async _admit(page, activate) {
    const id = await this._identify(page)
    if (typeof id !== "string" || id.length === 0) throw new Error("browser tab has no stable CDP target id")
    const collision = this._tabs.get(id)
    if (collision && collision !== page) throw new Error(`duplicate browser tab id: ${id}`)

    this._tabs.set(id, page)
    this._pageIDs.set(page, id)
    if (activate) this._activeID = id
    this._onOwn(page)
    page.once("close", () => this.forget(page))
    page.on("popup", (popup) => {
      void this.own(popup, { activate: true }).catch((error) => this._onError("popup ownership", error))
    })
    return id
  }

  async open(context) {
    const page = await context.newPage()
    await this.own(page, { activate: true })
    return page
  }

  active() {
    if (!this._activeID) return null
    const page = this._tabs.get(this._activeID) ?? null
    if (!page || page.isClosed()) {
      if (page) this.forget(page)
      return null
    }
    return page
  }

  activeID() {
    return this.active() ? this._activeID : null
  }

  id(page) {
    return this._pageIDs.get(page) ?? null
  }

  entries() {
    const entries = []
    for (const [id, page] of this._tabs) {
      if (page.isClosed()) {
        this.forget(page)
        continue
      }
      entries.push({ id, page, active: id === this._activeID })
    }
    return entries
  }

  select(id) {
    const page = this._tabs.get(id)
    if (!page || page.isClosed()) {
      if (page) this.forget(page)
      throw new Error(`browser tab does not exist: ${id}`)
    }
    this._activeID = id
    return page
  }

  async close(id) {
    const page = this.select(id)
    try {
      await page.close()
    } finally {
      this.forget(page)
    }
  }

  forget(page) {
    const id = this._pageIDs.get(page)
    if (!id) return
    this._pageIDs.delete(page)
    this._tabs.delete(id)
    if (this._activeID === id) this._activeID = this._tabs.keys().next().value ?? null
  }

  detach() {
    const pages = [...this._tabs.values()]
    this._tabs.clear()
    this._pageIDs = new WeakMap()
    this._pending = new WeakMap()
    this._activeID = null
    return pages
  }

  async closeAll() {
    const pages = this.detach()
    await Promise.allSettled(pages.map((page) => (page.isClosed() ? Promise.resolve() : page.close())))
  }
}
