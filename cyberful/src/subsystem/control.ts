// ── Runtime-Neutral Live Session Steering ───────────────────────
// Queues human input for a session, delivers it to every currently registered
// turn controller, and bounds acknowledgement while hiding native runtime protocol.
// → cyberful/src/subsystem/codex-control.ts — adapts active Codex turns.
// ─────────────────────────────────────────────────────────────────

export interface SteeringRequest {
  text: string
}

export interface SteeringAcknowledgement {
  accepted: boolean
  recipients: number
}

export interface TurnControl {
  steer(request: SteeringRequest): Promise<SteeringAcknowledgement>
}

interface PendingSteer {
  resolveTurn: (turn: TurnControl | undefined) => void
}

interface Entry {
  scopes: number
  turns: Set<TurnControl>
  pending: Set<PendingSteer>
}

export const STEER_ACK_TIMEOUT_MS = 10_000

const rejected = { accepted: false, recipients: 0 } satisfies SteeringAcknowledgement
const sessions = new Map<string, Entry>()

function entry(sessionID: string): Entry {
  const current = sessions.get(sessionID)
  if (current) return current
  const created = { scopes: 0, turns: new Set<TurnControl>(), pending: new Set<PendingSteer>() }
  sessions.set(sessionID, created)
  return created
}

function removeIfIdle(sessionID: string, current: Entry): void {
  if (current.scopes === 0 && current.turns.size === 0 && current.pending.size === 0) sessions.delete(sessionID)
}

async function deliverTo(turns: readonly TurnControl[], request: SteeringRequest): Promise<SteeringAcknowledgement> {
  const results = await Promise.allSettled(turns.map((turn) => Promise.resolve().then(() => turn.steer(request))))
  const recipients = results.reduce(
    (count, result) => count + (result.status === "fulfilled" && result.value.accepted ? result.value.recipients : 0),
    0,
  )
  return { accepted: recipients > 0, recipients }
}

async function beforeDeadline<T>(
  delivery: Promise<T>,
  timeoutMs: number,
  fallback: T,
  expire?: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>((resolve) => {
    timeout = setTimeout(
      () => {
        expire?.()
        resolve(fallback)
      },
      Math.max(0, timeoutMs),
    )
    timeout.unref?.()
  })
  try {
    return await Promise.race([delivery, deadline])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

// ── A Queued Steer Owns Its Successor Delivery ─────────────────
// Steering may arrive between two sequential phase turns, when the session is
// open but no runtime controller exists. The waiting steer owns both stages:
// registration supplies exactly one successor controller synchronously, then
// the original caller awaits that controller's acknowledgement within the same
// deadline. Registration therefore starts no detached promise, and expiry or
// session closure removes the queued request before a later turn can receive it.
// ────────────────────────────────────────────────────────────────
async function deliverToSuccessor(
  sessionID: string,
  current: Entry,
  request: SteeringRequest,
  timeoutMs: number,
): Promise<SteeringAcknowledgement> {
  const deadlineAt = Date.now() + Math.max(0, timeoutMs)
  const turnReady = Promise.withResolvers<TurnControl | undefined>()
  const pending = { resolveTurn: turnReady.resolve }
  current.pending.add(pending)
  const expire = () => {
    current.pending.delete(pending)
    removeIfIdle(sessionID, current)
  }
  const turn = await beforeDeadline(turnReady.promise, timeoutMs, undefined, expire)
  if (!turn) return rejected
  return beforeDeadline(deliverTo([turn], request), deadlineAt - Date.now(), rejected)
}

export function open(sessionID: string): () => void {
  const current = entry(sessionID)
  current.scopes++
  let closed = false
  return () => {
    if (closed) return
    closed = true
    current.scopes = Math.max(0, current.scopes - 1)
    if (current.scopes === 0) {
      for (const pending of current.pending) pending.resolveTurn(undefined)
      current.pending.clear()
    }
    removeIfIdle(sessionID, current)
  }
}

export function register(sessionID: string, turn: TurnControl): () => void {
  const current = entry(sessionID)
  current.turns.add(turn)
  for (const pending of current.pending) {
    current.pending.delete(pending)
    pending.resolveTurn(turn)
  }
  let removed = false
  return () => {
    if (removed) return
    removed = true
    current.turns.delete(turn)
    removeIfIdle(sessionID, current)
  }
}

export function steer(input: {
  sessionID: string
  text: string
  timeoutMs?: number
}): Promise<SteeringAcknowledgement> {
  const current = sessions.get(input.sessionID)
  if (!current) return Promise.resolve(rejected)
  const timeoutMs = input.timeoutMs ?? STEER_ACK_TIMEOUT_MS
  const request = { text: input.text }
  if (current.turns.size > 0) return beforeDeadline(deliverTo([...current.turns], request), timeoutMs, rejected)
  if (current.scopes === 0) return Promise.resolve(rejected)
  return deliverToSuccessor(input.sessionID, current, request, timeoutMs)
}

export function activeCount(sessionID: string): number {
  return sessions.get(sessionID)?.turns.size ?? 0
}

export function resetForTests(): void {
  for (const current of sessions.values()) {
    for (const pending of current.pending) pending.resolveTurn(undefined)
  }
  sessions.clear()
}

export * as SubsystemControl from "./control"
