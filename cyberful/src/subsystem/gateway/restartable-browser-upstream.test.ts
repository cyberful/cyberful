// ── Restartable Browser MCP Tests ───────────────────────────────
// Proves cancellation quarantine, single-flight replacement, non-retry of the
// failed operation, and shutdown races without spawning a real browser.
// → cyberful/src/subsystem/gateway/restartable-browser-upstream.ts — owns the tested recovery gate.
// ────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { RestartableBrowserUpstream } from "./restartable-browser-upstream"

interface FakeConnection {
  readonly id: number
  alive: boolean
}

function fixture(cancellationGraceMs = 1, probe?: (value: FakeConnection, signal: AbortSignal) => Promise<void>) {
  const connections: FakeConnection[] = []
  const closes: number[] = []
  const closedCallbacks = new Map<number, () => void>()
  const upstream = new RestartableBrowserUpstream<FakeConnection>({
    cancellationGraceMs,
    connect: async (onClose) => {
      const value = { id: connections.length + 1, alive: true }
      connections.push(value)
      closedCallbacks.set(value.id, onClose)
      return {
        value,
        close: async () => {
          value.alive = false
          closes.push(value.id)
          onClose()
        },
      }
    },
    probe:
      probe ??
      (async (value) => {
        if (!value.alive) throw new Error("transport closed")
      }),
    probeTimeoutMs: 50,
  })
  return { closes, closedCallbacks, connections, upstream }
}

test("does not retry a cancelled target action and replaces a dead generation before the next call", async () => {
  const { closedCallbacks, connections, upstream } = fixture()
  const controller = new AbortController()
  let attempts = 0
  const interrupted = upstream.call(async () => {
    attempts += 1
    controller.abort(new Error("deadline"))
    throw controller.signal.reason
  }, controller.signal)
  await expect(interrupted).rejects.toThrow("deadline")
  connections[0]!.alive = false
  closedCallbacks.get(1)?.()

  expect(await upstream.call(async (connection) => connection.id)).toBe(2)
  expect(attempts).toBe(1)
  await upstream.close()
})

test("probes a quarantined live generation without replacing it", async () => {
  const { connections, upstream } = fixture()
  const controller = new AbortController()
  await expect(
    upstream.call(async () => {
      controller.abort(new Error("deadline"))
      throw controller.signal.reason
    }, controller.signal),
  ).rejects.toThrow("deadline")

  expect(await upstream.call(async (connection) => connection.id)).toBe(1)
  expect(connections).toHaveLength(1)
  await upstream.close()
})

test("coalesces concurrent recovery onto one new generation", async () => {
  const { closedCallbacks, connections, upstream } = fixture(0)
  await upstream.start()
  connections[0]!.alive = false
  closedCallbacks.get(1)?.()

  const ids = await Promise.all(
    Array.from({ length: 20 }, () => upstream.call(async (connection) => connection.id)),
  )
  expect(new Set(ids)).toEqual(new Set([2]))
  expect(connections).toHaveLength(2)
  await upstream.close()
})

test("holds concurrent callers behind one post-cancellation health probe", async () => {
  let releaseProbe: (() => void) | undefined
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve
  })
  let probes = 0
  const { upstream } = fixture(1, async () => {
    probes += 1
    await probeGate
  })
  const controller = new AbortController()
  await expect(
    upstream.call(async () => {
      controller.abort(new Error("deadline"))
      throw controller.signal.reason
    }, controller.signal),
  ).rejects.toThrow("deadline")

  let operations = 0
  const calls = Array.from({ length: 20 }, () =>
    upstream.call(async (connection) => {
      operations += 1
      return connection.id
    }),
  )
  await Bun.sleep(5)
  expect(probes).toBe(1)
  expect(operations).toBe(0)
  releaseProbe?.()
  expect(new Set(await Promise.all(calls))).toEqual(new Set([1]))
  expect(operations).toBe(20)
  await upstream.close()
})

test("lets one caller abort without cancelling the shared recovery", async () => {
  let releaseProbe: (() => void) | undefined
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve
  })
  let probes = 0
  const { upstream } = fixture(1, async () => {
    probes += 1
    await probeGate
  })
  const timedOut = new AbortController()
  await expect(
    upstream.call(async () => {
      timedOut.abort(new Error("first deadline"))
      throw timedOut.signal.reason
    }, timedOut.signal),
  ).rejects.toThrow("first deadline")

  const waiting = new AbortController()
  const abandoned = upstream.call(async (connection) => connection.id, waiting.signal)
  await Bun.sleep(5)
  expect(probes).toBe(1)
  waiting.abort(new Error("second deadline"))
  await expect(abandoned).rejects.toThrow("second deadline")
  releaseProbe?.()
  expect(await upstream.call(async (connection) => connection.id)).toBe(1)
  await upstream.close()
})

test("times out a health probe that cannot settle and replaces its generation", async () => {
  let probes = 0
  const { connections, upstream } = fixture(1, async (value, signal) => {
    probes += 1
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
    value.alive = false
  })
  const controller = new AbortController()
  await expect(
    upstream.call(async () => {
      controller.abort(new Error("deadline"))
      throw controller.signal.reason
    }, controller.signal),
  ).rejects.toThrow("deadline")

  expect(await upstream.call(async (connection) => connection.id)).toBe(2)
  expect(probes).toBe(1)
  expect(connections).toHaveLength(2)
  await upstream.close()
})

test("rejects a transport that closes before its generation becomes active", async () => {
  const upstream = new RestartableBrowserUpstream({
    cancellationGraceMs: 0,
    connect: async (onClose) => {
      onClose()
      return { value: { id: 1 }, close: async () => undefined }
    },
    probe: async () => undefined,
    probeTimeoutMs: 50,
  })
  await expect(upstream.start()).rejects.toThrow("transport closed")
  await upstream.close()
})

test("invalidates transport failures but leaves the failed action for its caller to classify", async () => {
  const { closes, upstream } = fixture(0)
  let attempts = 0
  await expect(
    upstream.call(async () => {
      attempts += 1
      throw new Error("transport lost")
    }),
  ).rejects.toThrow("transport lost")
  expect(attempts).toBe(1)
  expect(closes).toEqual([1])
  expect(await upstream.call(async (connection) => connection.id)).toBe(2)
  await upstream.close()
})
