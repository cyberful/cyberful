// ── Installation Build Identity ──────────────────────────────────
// Normalizes compile-time release definitions and source-run fallbacks into the
// version, channel, and build identity used by runtime diagnostics and caches.
// → cyberful/src/bootstrap-config.ts — scopes materialized assets by build identity.
// ─────────────────────────────────────────────────────────────────

declare global {
  const CYBERFUL_VERSION: string
  const CYBERFUL_CHANNEL: string
  const CYBERFUL_BUILD_ID: string
}

export const InstallationVersion = typeof CYBERFUL_VERSION === "string" ? CYBERFUL_VERSION : "local"
export const InstallationChannel = typeof CYBERFUL_CHANNEL === "string" ? CYBERFUL_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
export const InstallationBuildID =
  typeof CYBERFUL_BUILD_ID === "string" && CYBERFUL_BUILD_ID.length > 0
    ? CYBERFUL_BUILD_ID
    : typeof process === "object"
      ? process.env.CYBERFUL_BUILD_ID?.trim() || "source-unbundled"
      : "source-unbundled"
