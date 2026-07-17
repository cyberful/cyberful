// ── Persisted Tool Display Contracts ─────────────────────────────
// Models the historical tool input and metadata shapes rendered by the TUI while
//   keeping presentation independent from obsolete host-side implementations.
// ─────────────────────────────────────────────────────────────────

declare const Parameters: unique symbol
declare const Metadata: unique symbol

type Dict = Record<string, unknown>

export type Info<P extends Dict = Dict, M extends Dict = Dict> = {
  readonly [Parameters]: P
  readonly [Metadata]: M
}

export type InferParameters<T> = T extends Info<infer P, Dict> ? P : never
export type InferMetadata<T> = T extends Info<Dict, infer M> ? M : never

export type ShellTool = Info<
  {
    command: string
    timeout?: number
    workdir?: string
    description: string
  },
  {
    output: string
    exit: number
    description: string
    truncated: boolean
    outputPath?: string
  }
>

export type ApplyPatchTool = Info<
  { patchText: string },
  {
    diff: string
    files: Array<{
      filePath: string
      relativePath: string
      type: "add" | "update" | "delete" | "move"
      patch: string
      additions: number
      deletions: number
      movePath?: string
    }>
  }
>

export type InvalidTool = Info<{ tool: string; error: string }>
export type WebFetchTool = Info<{ url: string; format?: "text" | "markdown" | "html"; timeout?: number }>
export type SkillTool = Info<{ name: string }>
export type TodoWriteTool = Info<
  { todos: Array<{ content: string; status: string; priority: string }> },
  { todos: Array<{ content: string; status: string; priority: string }> }
>
export type QuestionTool = Info<
  { questions: Array<{ question: string }> },
  { answers: ReadonlyArray<ReadonlyArray<string>> }
>
