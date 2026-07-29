// ── TUI Frame Batcher ────────────────────────────────────────────
// Groups bursty event values by owner and commits each owner's ordered batch
//   at most once per rendering window.
// → cyberful/src/cli/cmd/tui/context/sync.tsx — batches phase activity by session.
// ─────────────────────────────────────────────────────────────────

interface FrameBatcherHooks {
  readonly schedule?: (callback: () => void, delayMs: number) => unknown
  readonly cancel?: (handle: unknown) => void
}

export class FrameBatcher<Key, Value> {
  readonly #queues = new Map<Key, Value[]>()
  readonly #handles = new Map<Key, unknown>()
  readonly #schedule: (callback: () => void, delayMs: number) => unknown
  readonly #cancel: (handle: unknown) => void

  constructor(
    private readonly delayMs: number,
    private readonly commit: (key: Key, values: readonly Value[]) => void,
    hooks: FrameBatcherHooks = {},
  ) {
    this.#schedule = hooks.schedule ?? ((callback, delay) => setTimeout(callback, delay))
    this.#cancel = hooks.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  add(key: Key, value: Value) {
    this.#queues.set(key, [...(this.#queues.get(key) ?? []), value])
    if (this.#handles.has(key)) return
    this.#handles.set(
      key,
      this.#schedule(() => this.flush(key), this.delayMs),
    )
  }

  flush(key: Key) {
    this.#handles.delete(key)
    const values = this.#queues.get(key) ?? []
    this.#queues.delete(key)
    if (values.length > 0) this.commit(key, values)
  }

  dispose() {
    this.#handles.forEach((handle) => this.#cancel(handle))
    this.#handles.clear()
    this.#queues.clear()
  }
}
