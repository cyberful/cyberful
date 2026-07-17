// ── Session Phase Epoch Derivation ─────────────────────────────────────
// Derives one phase identity, completion count, and steering eligibility from session history.
// → cyberful/src/session/prompt.ts — checks the epoch before accepting live steering.
// ───────────────────────────────────────────────────────────────────────

import { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"
import { isRecord } from "@/util/record"

export interface Identity {
  readonly agent: string
  readonly firstUserMessageID: MessageID
  readonly enteredAt: number
}

export interface Snapshot extends Identity {
  readonly completionCount: number
}

export type Eligibility = "grace" | "waiting" | "ready"

export function isContinuation(message: MessageV2.WithParts) {
  if (message.info.role !== "user") return false
  const metadata = message.info.metadata
  const router = isRecord(metadata?.model_router) ? metadata.model_router : undefined
  if (router?.fallback === true) return true
  if (metadata?.synthetic === true || metadata?.delivery === "immediate") return true
  return message.parts.some((part) => "synthetic" in part && part.synthetic === true)
}

export function derive(messages: readonly MessageV2.WithParts[]): Snapshot | undefined {
  const ordered = MessageV2.active([...messages]).toSorted((a, b) => {
    const created = a.info.time.created - b.info.time.created
    if (created !== 0) return created
    return a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0
  })
  const users = ordered.filter(
    (message): message is MessageV2.WithParts & { info: MessageV2.User } => message.info.role === "user",
  )
  const boundary = users.reduce<(typeof users)[number] | undefined>((current, message) => {
    if (!current || current.info.agent !== message.info.agent || !isContinuation(message)) return message
    return current
  }, undefined)
  if (!boundary) return

  return {
    agent: boundary.info.agent,
    firstUserMessageID: boundary.info.id,
    enteredAt: boundary.info.time.created,
    completionCount: ordered.filter(
      (message) =>
        message.info.role === "assistant" &&
        message.info.id > boundary.info.id &&
        message.info.agent === boundary.info.agent &&
        message.info.time.completed !== undefined &&
        Boolean(message.info.finish) &&
        message.info.error === undefined,
    ).length,
  }
}

export function same(left: Identity | undefined, right: Identity | undefined) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.agent === right.agent &&
    left.firstUserMessageID === right.firstUserMessageID &&
    left.enteredAt === right.enteredAt
  )
}

export function matches(messages: readonly MessageV2.WithParts[], expected: Identity) {
  return same(derive(messages), expected)
}

export function key(identity: Identity) {
  return `${identity.agent}:${identity.firstUserMessageID}:${identity.enteredAt}`
}

export function eligibility(snapshot: Snapshot, now: number, graceMs: number): Eligibility {
  if (now < snapshot.enteredAt + graceMs) return "grace"
  return snapshot.completionCount > 0 ? "ready" : "waiting"
}

export * as SessionPhaseEpoch from "./phase-epoch"
