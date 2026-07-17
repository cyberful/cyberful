// ── Current Project Instance Reference ─────────────────────────────
// Defines the fiber-local reference used to carry one optional project context
// through Effect services and callback bridges without a mutable global value.
// → cyberful/src/project/instance-context.ts — defines the referenced context.
// ────────────────────────────────────────────────────────────────────

import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~cyberful/InstanceRef", {
  defaultValue: () => undefined,
})
