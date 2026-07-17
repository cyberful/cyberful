// ── SQL Asset Module Contract ────────────────────────────────────
// Types bundled SQL imports as migration or query text.
// ─────────────────────────────────────────────────────────────────

declare module "*.sql" {
  const content: string
  export default content
}
