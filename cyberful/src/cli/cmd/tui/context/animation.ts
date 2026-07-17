// ── Global TUI Animation Policy ─────────────────────────────────
// Resolves the persistent animation preference only after TUI preferences load
//   and exposes one accessor shared by every animated component.
// → cyberful/src/cli/cmd/tui/context/kv.tsx — owns persistent preference loading and writes.
// ─────────────────────────────────────────────────────────────────

import { useKV } from "./kv"

// ── Preference Loading Defaults To A Static Interface ───────────
// The persisted value arrives asynchronously after the component tree mounts.
// Treating that interval as enabled would briefly start live renderables and
// animated spinners before a saved disabled preference can take effect. The
// shared policy therefore stays static until loading completes, then follows the
// validated boolean preference for the rest of the process lifetime.
// ─────────────────────────────────────────────────────────────────
export function animationPreferenceEnabled(ready: boolean, enabled: boolean) {
  return ready && enabled
}

export function useAnimationsEnabled() {
  const kv = useKV()
  return () => animationPreferenceEnabled(kv.ready, kv.get("animations_enabled", true))
}
