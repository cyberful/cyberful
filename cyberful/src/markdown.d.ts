// ── Markdown Asset Module Contract ───────────────────────────────
// Types bundled Markdown imports as their embedded text content.
// ─────────────────────────────────────────────────────────────────

declare module "*.md" {
  const content: string
  export default content
}
