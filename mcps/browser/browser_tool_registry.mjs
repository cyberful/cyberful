// ── Browser Tool Registry ────────────────────────────────────────
// Pairs each public browser schema with one handler and rejects duplicate names
//   before the stdio server starts.
// ─────────────────────────────────────────────────────────────────

export class BrowserToolRegistry {
  #tools = new Map()

  register(tool) {
    if (!tool || typeof tool.name !== "string" || !tool.name) throw new Error("browser tool requires a name")
    if (this.#tools.has(tool.name)) throw new Error(`duplicate browser tool: ${tool.name}`)
    if (!tool.inputSchema || tool.inputSchema.type !== "object")
      throw new Error(`browser tool ${tool.name} requires an object input schema`)
    if (typeof tool.handler !== "function") throw new Error(`browser tool ${tool.name} requires a handler`)
    this.#tools.set(tool.name, tool)
  }

  find(name) {
    return this.#tools.get(name)
  }

  definitions() {
    return [...this.#tools.values()].map(({ handler: _handler, ...definition }) => definition)
  }
}
