// ── Bun Test Preload Boundary ────────────────────────────────────
// Keeps the project test preload as an explicit side-effect-free module while
// Bun loads the OpenTUI Solid preload configured alongside it.
// → cyberful/bunfig.toml — registers this module for every Bun test process.
// ─────────────────────────────────────────────────────────────────

export {}
