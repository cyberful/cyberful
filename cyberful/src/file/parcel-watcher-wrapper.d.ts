// ── Parcel Watcher Wrapper Types ─────────────────────────────────
// Describes the package's untyped native-binding adapter so the workspace watcher
//   can load platform implementations without suppressing TypeScript validation.
// ─────────────────────────────────────────────────────────────────

declare module "@parcel/watcher/wrapper" {
  import type * as ParcelWatcher from "@parcel/watcher"

  export function createWrapper(binding: unknown): typeof ParcelWatcher
}
