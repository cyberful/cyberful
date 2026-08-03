// ── Workspace Scan Ignore Rules ──────────────────────────────────
// Defines the generated, dependency, cache, operating-system, and caller-added
//   patterns excluded from workspace scans while honoring explicit allowlists.
// ─────────────────────────────────────────────────────────────────

const FOLDERS = new Set([
  "node_modules",
  "bower_components",
  ".pnpm-store",
  "vendor",
  ".npm",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  "bin",
  "obj",
  ".git",
  ".svn",
  ".hg",
  ".vscode",
  ".idea",
  ".turbo",
  ".output",
  "desktop",
  ".sst",
  ".cache",
  ".webkit-cache",
  "__pycache__",
  ".pytest_cache",
  "mypy_cache",
  ".history",
  ".gradle",
])

const FILES = [
  "**/*.swp",
  "**/*.swo",

  "**/*.pyc",

  // OS
  "**/.DS_Store",
  "**/Thumbs.db",

  // Logs & temp
  "**/logs/**",
  "**/tmp/**",
  "**/temp/**",
  "**/*.log",

  // Coverage/test outputs
  "**/coverage/**",
  "**/.nyc_output/**",
]

export const PATTERNS = [...FILES, ...FOLDERS]

export * as FileIgnore from "./ignore"
