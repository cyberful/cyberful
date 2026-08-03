// ── Bounded Process Output ───────────────────────────────────────
// Retains a fixed prefix or tail from process streams while continuing to
// drain discarded output, preventing child deadlocks and unbounded memory use.
// ─────────────────────────────────────────────────────────────────

export async function readBoundedPrefix(stream: ReadableStream<Uint8Array> | null, limit: number) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("output limit must be a positive safe integer")
  if (!stream) return { text: "", truncated: false }

  const reader = stream.getReader()
  const bytes = new Uint8Array(limit)
  let retained = 0
  let truncated = false
  while (true) {
    const next = await reader.read()
    if (next.done) break
    const count = Math.min(next.value.byteLength, limit - retained)
    if (count > 0) {
      bytes.set(next.value.subarray(0, count), retained)
      retained += count
    }
    truncated ||= count < next.value.byteLength
  }
  return { text: new TextDecoder().decode(bytes.subarray(0, retained)), truncated }
}

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
