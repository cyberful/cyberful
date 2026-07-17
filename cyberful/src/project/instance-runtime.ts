// ── Promise Instance Runtime Bridge ─────────────────────────────────────────
// Adapts Promise and async-local callers to the scoped Effect instance store
// while preserving that store's load, reload, and disposal ownership.
// → cyberful/src/project/instance-store.ts — owns the underlying instance lifetime.
// ─────────────────────────────────────────────────────────────────────

import { AppRuntime } from "@/effect/app-runtime"
import { type InstanceContext } from "./instance-context"
import { InstanceStore, type LoadInput } from "./instance-store"

export const load = (input: LoadInput) => AppRuntime.runPromise(InstanceStore.Service.use((store) => store.load(input)))
export const disposeInstance = (ctx: InstanceContext) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.dispose(ctx)))
export const disposeAllInstances = () => AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeAll()))
export const reloadInstance = (input: LoadInput) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.reload(input)))

export * as InstanceRuntime from "./instance-runtime"
