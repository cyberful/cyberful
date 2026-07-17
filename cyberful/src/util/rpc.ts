// ── TUI Worker RPC Protocol ──────────────────────────────────────
// Exchanges bounded JSON envelopes between the TUI and its worker and validates
// method inputs, results, and events against one shared runtime contract.
// → cyberful/src/cli/cmd/tui/rpc-contract.ts — defines the worker boundary decoders.
// → cyberful/src/cli/cmd/tui/thread.ts — owns the client and Worker lifetime.
// → cyberful/src/cli/cmd/tui/worker.ts — serves methods and emits runtime events.
// ─────────────────────────────────────────────────────────────────

import { observePromise } from "./promise"

export type Decoder<Value> = (value: unknown) => Value

export interface MethodContract<Input = unknown, Result = unknown> {
  readonly input: Decoder<Input>
  readonly result: Decoder<Result>
}

type MethodContracts = Readonly<Record<string, MethodContract>>
type EventContracts = Readonly<Record<string, Decoder<unknown>>>

export interface ContractShape {
  readonly methods: MethodContracts
  readonly events: EventContracts
}

type Decoded<D> = D extends Decoder<infer Value> ? Value : never
type Awaitable<Value> = Value | Promise<Value>

export type Definition<C extends ContractShape> = {
  readonly [Name in keyof C["methods"]]: (
    input: Decoded<C["methods"][Name]["input"]>,
  ) => Awaitable<Decoded<C["methods"][Name]["result"]>>
}

type RequestMessage = {
  type: "rpc.request"
  id: number
  method: string
  input: unknown
}

type ResultMessage = {
  type: "rpc.result"
  id: number
  result: unknown
}

type ErrorMessage = {
  type: "rpc.error"
  id: number
  message: string
}

type EventMessage = {
  type: "rpc.event"
  event: string
  data: unknown
}

type ProtocolMessage = RequestMessage | ResultMessage | ErrorMessage | EventMessage

export interface Endpoint {
  postMessage(data: string): void
  onmessage: ((event: MessageEvent<unknown>) => void) | null
}

type PendingCall = {
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
}

const MAX_MESSAGE_CHARACTERS = 16 * 1024 * 1024
const MAX_PROTOCOL_NAME_CHARACTERS = 256
const MAX_REMOTE_ERROR_CHARACTERS = 4_096

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorValue(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function protocolName(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROTOCOL_NAME_CHARACTERS) {
    throw new TypeError(`${label} must contain 1-${MAX_PROTOCOL_NAME_CHARACTERS} characters`)
  }
  return value
}

function parseMessage(data: unknown): ProtocolMessage {
  if (typeof data !== "string") throw new TypeError("RPC message must be a JSON string")
  if (data.length > MAX_MESSAGE_CHARACTERS) {
    throw new TypeError(`RPC message exceeds ${MAX_MESSAGE_CHARACTERS} characters`)
  }

  const value: unknown = JSON.parse(data)
  if (!isRecord(value) || typeof value.type !== "string") throw new TypeError("RPC message requires a type")

  if (value.type === "rpc.event") {
    return {
      type: value.type,
      event: protocolName(value.event, "RPC event name"),
      data: value.data,
    }
  }

  if (typeof value.id !== "number" || !Number.isSafeInteger(value.id) || value.id < 0) {
    throw new TypeError("RPC request or response requires a non-negative safe integer id")
  }

  if (value.type === "rpc.request") {
    return {
      type: value.type,
      id: value.id,
      method: protocolName(value.method, "RPC method name"),
      input: value.input,
    }
  }
  if (value.type === "rpc.result") return { type: value.type, id: value.id, result: value.result }
  if (value.type === "rpc.error" && typeof value.message === "string") {
    return { type: value.type, id: value.id, message: value.message.slice(0, MAX_REMOTE_ERROR_CHARACTERS) }
  }
  throw new TypeError(`Unsupported RPC message type: ${value.type}`)
}

function serializeMessage(message: ProtocolMessage) {
  const data = JSON.stringify(message)
  if (data.length > MAX_MESSAGE_CHARACTERS) {
    throw new TypeError(`RPC message exceeds ${MAX_MESSAGE_CHARACTERS} characters`)
  }
  return data
}

function send(endpoint: Endpoint | undefined, message: ProtocolMessage) {
  const data = serializeMessage(message)
  if (endpoint) endpoint.postMessage(data)
  else postMessage(data)
}

function remoteErrorMessage(error: unknown) {
  const value = errorValue(error)
  return (value.message || value.name || "RPC method failed").slice(0, MAX_REMOTE_ERROR_CHARACTERS)
}

function validateContractName(name: string, label: string) {
  protocolName(name, label)
}

export function contract<const Methods extends MethodContracts, const Events extends EventContracts>(value: {
  readonly methods: Methods
  readonly events: Events
}) {
  for (const [name, method] of Object.entries(value.methods)) {
    validateContractName(name, "RPC method name")
    if (typeof method.input !== "function" || typeof method.result !== "function") {
      throw new TypeError(`RPC method ${name} requires input and result decoders`)
    }
  }
  for (const [name, decoder] of Object.entries(value.events)) {
    validateContractName(name, "RPC event name")
    if (typeof decoder !== "function") throw new TypeError(`RPC event ${name} requires a decoder`)
  }
  return value
}

// ── Contract Keys Retain Their Decoder Association ───────────────
// TypeScript widens an indexed lookup through the ContractShape constraint to
// an unknown decoder even when the key is a generic member of the exact contract.
// Calls and subscriptions accept only those exact keys, and contract creation has
// already verified both decoder slots. These assertions restore the key-specific
// decoder types without accepting a wider runtime name or bypassing validation.
// ─────────────────────────────────────────────────────────────────
function methodAt<C extends ContractShape, Name extends keyof C["methods"] & string>(protocol: C, name: Name) {
  return protocol.methods[name] as MethodContract<
    Decoded<C["methods"][Name]["input"]>,
    Decoded<C["methods"][Name]["result"]>
  >
}

function eventAt<C extends ContractShape, Name extends keyof C["events"] & string>(protocol: C, name: Name) {
  return protocol.events[name] as Decoder<Decoded<C["events"][Name]>>
}

export function listen<C extends ContractShape>(protocol: C, handlers: Definition<C>, endpoint?: Endpoint) {
  const methods: MethodContracts = protocol.methods

  // ── Dynamic Dispatch Erases Only A Validated Method Pair ────────
  // The contract and handler mapping share the same compile-time method keys.
  // Runtime setup verifies that every contract key has a function before any
  // request can be accepted. Each request then passes through that key's input
  // decoder before invocation and its result decoder before transport. The
  // assertion erases parameter variance only after this pairing is established.
  // ─────────────────────────────────────────────────────────────────
  const runtimeHandlers = handlers as unknown as Readonly<Record<string, (input: unknown) => unknown>>
  for (const name of Object.keys(methods)) {
    if (typeof runtimeHandlers[name] !== "function") throw new TypeError(`RPC handler is missing: ${name}`)
  }
  for (const name of Object.keys(runtimeHandlers)) {
    if (!methods[name]) throw new TypeError(`RPC handler has no contract: ${name}`)
  }

  async function respond(message: RequestMessage) {
    try {
      const specification = methods[message.method]
      const handler = runtimeHandlers[message.method]
      if (!specification || !handler) throw new Error(`Unknown RPC method: ${message.method}`)
      const input = specification.input(message.input)
      const result = specification.result(await handler(input))
      send(endpoint, { type: "rpc.result", result, id: message.id })
    } catch (error) {
      send(endpoint, {
        type: "rpc.error",
        message: remoteErrorMessage(error),
        id: message.id,
      })
    }
  }

  const receive = (event: MessageEvent<unknown>) => {
    const message = parseMessage(event.data)
    if (message.type !== "rpc.request") throw new TypeError(`RPC server received ${message.type}`)
    observePromise(respond(message), {
      rejected: (error) => {
        queueMicrotask(() => {
          throw errorValue(error)
        })
      },
    })
  }

  if (endpoint) endpoint.onmessage = receive
  else onmessage = receive

  return () => {
    if (endpoint?.onmessage === receive) endpoint.onmessage = null
    if (!endpoint && onmessage === receive) onmessage = null
  }
}

export function emit<C extends ContractShape, Name extends keyof C["events"] & string>(
  protocol: C,
  event: Name,
  data: Decoded<C["events"][Name]>,
  endpoint?: Endpoint,
) {
  const decoded = eventAt(protocol, event)(data)
  send(endpoint, { type: "rpc.event", event, data: decoded })
}

export function client<C extends ContractShape>(target: Endpoint, protocol: C) {
  const methods: MethodContracts = protocol.methods
  const events: EventContracts = protocol.events
  const pending = new Map<number, PendingCall>()
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  let nextID = 0
  let closed = false

  function allocateRequestID() {
    for (let attempts = 0; attempts <= pending.size; attempts++) {
      const candidate = nextID
      nextID = nextID === Number.MAX_SAFE_INTEGER ? 0 : nextID + 1
      if (!pending.has(candidate)) return candidate
    }
    throw new Error("RPC request id space is exhausted")
  }

  const receive = (event: MessageEvent<unknown>) => {
    const message = parseMessage(event.data)
    if (message.type === "rpc.request") throw new TypeError("RPC client received a request")

    if (message.type === "rpc.result" || message.type === "rpc.error") {
      const call = pending.get(message.id)
      if (!call) throw new TypeError(`RPC response has no pending request: ${message.id}`)
      pending.delete(message.id)
      if (message.type === "rpc.error") call.reject(new Error(message.message))
      else call.resolve(message.result)
      return
    }

    const decoder = events[message.event]
    if (!decoder) throw new TypeError(`Unknown RPC event: ${message.event}`)
    decoder(message.data)
    const handlers = listeners.get(message.event)
    if (!handlers) return

    const failures: Error[] = []
    for (const handler of handlers) {
      try {
        handler(message.data)
      } catch (error) {
        failures.push(errorValue(error))
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, `RPC event handlers failed: ${message.event}`)
  }
  target.onmessage = receive

  function call<Name extends keyof C["methods"] & string>(
    method: Name,
    input: Decoded<C["methods"][Name]["input"]>,
  ): Promise<Decoded<C["methods"][Name]["result"]>> {
    if (closed) return Promise.reject(new Error("RPC client is closed"))
    const specification = methodAt(protocol, method)
    if (!specification || !methods[method]) return Promise.reject(new Error(`Unknown RPC method: ${method}`))

    let normalizedInput: Decoded<C["methods"][Name]["input"]>
    try {
      normalizedInput = specification.input(input)
    } catch (error) {
      return Promise.reject(errorValue(error))
    }

    const requestID = allocateRequestID()
    return new Promise<Decoded<C["methods"][Name]["result"]>>((resolve, reject) => {
      pending.set(requestID, {
        resolve: (result) => {
          try {
            resolve(specification.result(result))
          } catch (error) {
            reject(errorValue(error))
          }
        },
        reject,
      })
      try {
        target.postMessage(serializeMessage({ type: "rpc.request", method, input: normalizedInput, id: requestID }))
      } catch (error) {
        pending.delete(requestID)
        reject(errorValue(error))
      }
    })
  }

  function on<Name extends keyof C["events"] & string>(
    event: Name,
    handler: (data: Decoded<C["events"][Name]>) => void,
  ) {
    if (closed) throw new Error("RPC client is closed")
    const decoder = eventAt(protocol, event)
    if (!decoder || !events[event]) throw new Error(`Unknown RPC event: ${event}`)
    const listener = (data: unknown) => handler(decoder(data))
    const handlers = listeners.get(event) ?? new Set<(data: unknown) => void>()
    listeners.set(event, handlers)
    handlers.add(listener)
    return () => {
      handlers.delete(listener)
      if (handlers.size === 0) listeners.delete(event)
    }
  }

  function close(reason: unknown = new Error("RPC client closed")) {
    if (closed) return
    closed = true
    const error = errorValue(reason)
    for (const call of pending.values()) call.reject(error)
    pending.clear()
    listeners.clear()
    if (target.onmessage === receive) target.onmessage = null
  }

  return { call, on, close }
}

export * as Rpc from "./rpc"
