// ── Bounded Process Output Tail ──────────────────────────────────
// Retains the final byte window from a stream while counting discarded output,
// allowing process owners to keep draining without growing application memory.
// ─────────────────────────────────────────────────────────────────

// ── Retention Never Keeps An Oversized Source Chunk Alive ────────
// Stream chunks are untrusted boundary values and may themselves exceed the
// configured window. Appending therefore copies only bytes that can survive in
// the tail instead of retaining a view into the complete source allocation.
// Earlier chunks are trimmed or released immediately, while droppedBytes keeps
// truncation observable without preserving discarded content.
// ─────────────────────────────────────────────────────────────────
export class BoundedByteTail {
  readonly limit: number
  #chunks: Buffer[] = []
  #bytes = 0
  #droppedBytes = 0

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("output limit must be a positive safe integer")
    this.limit = limit
  }

  append(value: string | Uint8Array): void {
    const source = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value)
    const overflow = Math.max(0, this.#bytes + source.byteLength - this.limit)
    this.#droppedBytes += overflow

    if (source.byteLength >= this.limit) {
      this.#chunks = [Buffer.from(source.subarray(source.byteLength - this.limit))]
      this.#bytes = this.limit
      return
    }

    this.#chunks.push(source)
    this.#bytes += source.byteLength
    let remaining = overflow
    while (remaining > 0) {
      const first = this.#chunks[0]
      if (!first) throw new Error("bounded output lost its retained chunk")
      if (first.byteLength <= remaining) {
        this.#chunks.shift()
        this.#bytes -= first.byteLength
        remaining -= first.byteLength
        continue
      }
      this.#chunks[0] = Buffer.from(first.subarray(remaining))
      this.#bytes -= remaining
      remaining = 0
    }
  }

  get droppedBytes(): number {
    return this.#droppedBytes
  }

  get truncated(): boolean {
    return this.#droppedBytes > 0
  }

  bytes(): Buffer {
    return Buffer.concat(this.#chunks, this.#bytes)
  }

  text(): string {
    return this.bytes().toString("utf8")
  }
}
