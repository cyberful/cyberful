// ── Pending Task Reuse ───────────────────────────────────────────
// Shares one currently running asynchronous computation among concurrent callers
//   and clears the slot only when that exact computation settles.
// ─────────────────────────────────────────────────────────────────

type PendingTask<T> = {
  current?: Promise<T>
}

export function reusePendingTask<T>(slot: PendingTask<T>, run: () => Promise<T>) {
  if (slot.current) {
    return slot.current
  }

  const task = run().finally(() => {
    if (slot.current === task) {
      slot.current = undefined
    }
  })
  slot.current = task
  return task
}
