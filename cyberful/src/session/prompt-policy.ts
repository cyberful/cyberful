// ── Prompt Continuation Policy ───────────────────────────────────
// Keeps steering identity, degraded-state inheritance, and ZAP lifecycle
//   decisions independent from prompt execution.
// ─────────────────────────────────────────────────────────────────

import { SubsystemPhase } from "@/subsystem/phase"
import { EngagementStatus } from "./engagement-status"
import { MessageV2 } from "./message-v2"

export type ZapRuntimeLifecycle = "engagement" | "disabled"

export function zapRuntimeLifecycle(workflow: string): ZapRuntimeLifecycle {
  return SubsystemPhase.zapLifecycleFor(workflow)
}

export function steerHeadFields(lastUser: MessageV2.User | undefined) {
  return {
    agent: lastUser?.agent,
    workarea: typeof lastUser?.metadata?.workarea === "string" ? lastUser.metadata.workarea : undefined,
    metadata: lastUser ? MessageV2.continuationMetadata(lastUser.metadata) : undefined,
  }
}

export function carryEngagementStatus(input: {
  metadata: MessageV2.User["metadata"]
  delivery: "immediate" | "deferred" | undefined
  previousMetadata: MessageV2.User["metadata"]
}): NonNullable<MessageV2.User["metadata"]> {
  const inherit = input.delivery === "immediate" && EngagementStatus.isDegraded(input.previousMetadata)
  return {
    ...(input.metadata ?? {}),
    ...EngagementStatus.metadata(EngagementStatus.isDegraded(input.metadata) || inherit),
  }
}
