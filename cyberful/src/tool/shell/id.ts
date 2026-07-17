// ── Shell Tool Compatibility Identity ────────────────────────────
// Normalizes persisted shell variants while retaining the historical `bash`
//   tool identifier consumed by plugins and saved session parts.
// ─────────────────────────────────────────────────────────────────

const kinds = ["bash", "pwsh", "powershell", "cmd"] as const
export type Kind = (typeof kinds)[number]

const shellKinds = new Set<string>(kinds)

function isKind(value: string): value is Kind {
  return shellKinds.has(value)
}

export function toKind(value: string): Kind {
  return isKind(value) ? value : "bash"
}

// ── Persisted Shell Parts Keep The Historical Tool Identifier ───
// Plugins and stored sessions address every supported shell through `bash`.
// Runtime shell kind normalization is intentionally separate from that public ID.
// Changing this constant would make existing parts unreadable without migration.
// A future rename therefore belongs to a versioned persistence transition.
// ─────────────────────────────────────────────────────────────────
export const ToolID = "bash"
export type ToolID = typeof ToolID

export * as ShellID from "./id"
