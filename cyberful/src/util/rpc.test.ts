// ── Worker RPC Boundary Tests ────────────────────────────────────
// Exercises real linked endpoints to prove everyday calls and events cross the
// worker boundary only after input, result, and event validation.
// → cyberful/src/util/rpc.ts — implements the protocol exercised here.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { Rpc, type Endpoint } from "./rpc"

function text(value: unknown) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("expected non-empty text")
  return value
}

function count(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("expected a non-negative integer")
  }
  return value
}

const protocol = Rpc.contract({
  methods: {
    greet: { input: text, result: text },
    broken: { input: text, result: count },
  },
  events: {
    progress: count,
  },
})

function linkedEndpoints() {
  const client: Endpoint = {
    onmessage: null,
    postMessage(data) {
      queueMicrotask(() => server.onmessage?.(new MessageEvent("message", { data })))
    },
  }
  const server: Endpoint = {
    onmessage: null,
    postMessage(data) {
      queueMicrotask(() => client.onmessage?.(new MessageEvent("message", { data })))
    },
  }
  return { client, server }
}

describe("worker RPC boundary", () => {
  test("validates a routine request, result, and event on linked endpoints", async () => {
    const endpoints = linkedEndpoints()
    const stop = Rpc.listen(
      protocol,
      {
        greet: async (name) => `hello ${name}`,
        broken: async () => 1,
      },
      endpoints.server,
    )
    const client = Rpc.client(endpoints.client, protocol)
    const progress: number[] = []
    const unsubscribe = client.on("progress", (value) => progress.push(value))

    try {
      await expect(client.call("greet", "Ada")).resolves.toBe("hello Ada")
      Rpc.emit(protocol, "progress", 2, endpoints.server)
      await new Promise<void>((resolve) => queueMicrotask(resolve))
      expect(progress).toEqual([2])
    } finally {
      unsubscribe()
      client.close()
      stop()
    }
  })

  test("rejects an invalid result returned by the worker", async () => {
    const endpoints = linkedEndpoints()
    const stop = Rpc.listen(
      protocol,
      {
        greet: (name) => name,
        broken: () => -1,
      },
      endpoints.server,
    )
    const client = Rpc.client(endpoints.client, protocol)

    try {
      await expect(client.call("broken", "request")).rejects.toThrow("expected a non-negative integer")
    } finally {
      client.close()
      stop()
    }
  })

  test("rejects pending and future work when its owner closes", async () => {
    const endpoint: Endpoint = { onmessage: null, postMessage() {} }
    const client = Rpc.client(endpoint, protocol)
    const pending = client.call("greet", "Ada")
    client.close(new Error("worker terminated"))

    await expect(pending).rejects.toThrow("worker terminated")
    await expect(client.call("greet", "Grace")).rejects.toThrow("RPC client is closed")
  })

  test("rejects malformed input before it reaches the worker", async () => {
    let messages = 0
    const endpoint: Endpoint = {
      onmessage: null,
      postMessage() {
        messages++
      },
    }
    const client = Rpc.client(endpoint, protocol)

    try {
      await expect(client.call("greet", "")).rejects.toThrow("expected non-empty text")
      expect(messages).toBe(0)
    } finally {
      client.close()
    }
  })
})
