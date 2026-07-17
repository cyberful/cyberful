// ── Embedded Python Asset Contract ───────────────────────────────
// Types Python files imported as release-bundled text rather than executable modules.
// → cyberful/src/index.ts — materializes embedded runtime assets during startup.
// ─────────────────────────────────────────────────────────────────

declare module "*.py" {
  const content: string
  export default content
}
