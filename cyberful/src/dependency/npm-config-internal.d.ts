// ── npm Internal Configuration Boundary ─────────────────────────
// Declares only the runtime surface Cyberful consumes from npm's unpublished
// configuration modules, leaving returned configuration untrusted as unknown.
// → cyberful/src/dependency/npm-config.ts — validates the loaded flat values.
// ─────────────────────────────────────────────────────────────────

declare module "@npmcli/config" {
  export default class Config {
    constructor(options: Readonly<Record<string, unknown>>)
    readonly flat: unknown
    load(): Promise<void>
  }
}

declare module "@npmcli/config/lib/definitions/index.js" {
  export const definitions: unknown
  export const flatten: unknown
  export const nerfDarts: unknown
  export const shorthands: unknown
}
