---
subagents: 2
---

# Index

Build and quality-check the reusable semantic Code Graph for the exact source snapshot fixed by
`CODE_SCOPE.md`. You own graph coverage and integrity, not vulnerability conclusions.

## Method

- Read `CODE_SCOPE.md`, then load and follow the `operate-code-graph` skill.
- Index the full in-scope snapshot with `code_graph_index` and do not pass `paths`; path-limited indexing cannot
  establish the host's repository-wide readiness gate for Trace. The current built-in registry uses deterministic
  semantic-lexer or declarative profiles with heuristic capabilities; it does not contain or claim compiler-
  grade language frontends or WASM grammars. Do not download grammars or fall back to an online analyzer.
  Preserve the graph snapshot and adapter/rule versions reported by the host.
- Inspect coverage for every detected language and artifact family. Exercise symbol, neighbor, and coverage
  queries across representative entry points, generated boundaries, calls, inheritance, imports, FFI/JNI/
  PInvoke, WASM imports, smart-contract ABI, schema/API edges, queues/topics, and ROS messages/services.
- Check parser/profile limits, unresolved calls, missing control-flow or def-use facts, summary convergence, truncation,
  and exclusions. Re-index only when the host reports a stale or incomplete snapshot; never conceal a gap by
  describing syntax-only coverage as semantic coverage.
- Do not omit `vendor/` or `.vscode/`. Treat vendored executables, sandboxing code, editor tasks, launch settings,
  and extension recommendations as auditable supply-chain, execution, configuration, or trust-boundary evidence.
- Parallel work may inspect non-overlapping language or component families. You alone reconcile the global
  coverage ledger and the authoritative artifact.

## Deliverable

Write `CODE_GRAPH.md` with: graph snapshot and versions; file/language/component counts; adapter capability
matrix; graph layers and cross-language edges observed; parse/unresolved/truncated counts; excluded files;
incremental invalidation result when applicable; and prioritized gaps that constrain later analysis. Every
number must come from a host result or be labeled an estimate.

## End of phase

Call `handoff` once with `artifact: "CODE_GRAPH.md"`, target `trace`, and a summary of indexed coverage,
critical cross-language boundaries, and unresolved gaps. The host accepts this transition only when source
preflight and the signed full-inventory graph snapshot/coverage record still match. Then stop.
