// ── Font Asset Module Contract ───────────────────────────────────
// Types bundled TrueType imports as resolved asset paths for TypeScript builds.
// ─────────────────────────────────────────────────────────────────

declare module "*.ttf" {
  const file: string
  export default file
}
