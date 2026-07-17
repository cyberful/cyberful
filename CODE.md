# Cyberful Code Principles

This file is the mandatory code-writing canon for Cyberful. It applies to
humans and AI agents adding or changing source code and tests.

Repository and directory-level `AGENTS.md` files may add narrower operational
constraints. They must not weaken or contradict this document.

## Table Of Contents

1. [Authority And Scope](#01-authority-and-scope)
2. [Universal Principles](#02-universal-principles)
3. [File Header Contract](#03-file-header-contract)
4. [Literate Code](#04-literate-code)
5. [TypeScript](#05-typescript)
6. [Bun](#06-bun)
7. [Node.js And JavaScript](#07-nodejs-and-javascript)
8. [Python](#08-python)
9. [Testing](#09-testing)

## 01. Authority And Scope

These principles govern new code and every file materially changed by a patch.
Existing code is not a precedent when it conflicts with this canon.

## 02. Universal Principles

- Rename vague symbols instead of adding comments that explain them.
- Keep logic in one function unless extraction creates a reusable concept,
  isolates a genuinely complex boundary, or materially clarifies the happy path.
- Do not create single-use helpers merely to shorten a function.
- Validate untrusted input once at the boundary and pass a canonical internal
  representation inward.
- Make ownership, cancellation, cleanup, partial failure, and degraded behavior
  explicit wherever they are non-obvious.
- Never emit telemetry, analytics, update checks, or background network traffic.
- Treat compiler errors, type errors, test failures, warnings, and broken
  `@docs/` references as defects.

## 03. File Header Contract

Every repository-owned code file must begin with an accurate ornamental comment
that states what the file owns. This includes source, tests, and executable
scripts in every programming language.

Only a machine-required preamble, such as a shebang or encoding declaration, may
appear before the header.

```ts
// ── Phase Runtime Lifecycle ──────────────────────────────────────
// Starts one Codex app-server and retains its private gateway until
//   handoff, cancellation, or failure completes cleanup.
// → cyberful/src/subsystem/codex.ts — owns the app-server protocol.
// → cyberful/src/subsystem/gateway/server.ts — creates the gateway.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────
```

The header follows these rules:

- The title names the file's primary responsibility.
- The opening prose is mandatory and states what the file does or owns without a
  field label. It must not merely repeat the filename.
- Add one `→` line for each non-obvious relationship needed to understand the
  file. Use a repository-root-relative path and explain the relationship; do
  not list ordinary imports.
- Add one dedicated `@docs/<path>.md` line per relevant system document.
- Omit `→` or `@docs/` when no meaningful relationship exists; do not
  write `None` or add filler.
- Replace only the comment prefix when the language requires another one.
- Vendored third-party source is not repository-owned code and must not be
  rewritten solely to add a header.

The header is part of the file's contract. Update it in the same change whenever
the file's responsibility, boundaries, important relationships, or linked
documentation changes. A stale, generic, copied, or misleading header is a
defect.

An existing repository-owned code file without a header must gain one before a
functional change to that file is merged. Do not invent its responsibility;
derive the header from implementation, tests, callers, and documentation.

## 04. Literate Code

Literate code exposes reasoning that names and types cannot: intent, invariants,
trust boundaries, ownership, trade-offs, and failure behavior. It does not
explain syntax or obvious control flow.

### Mandatory Format

Every literate section must use the complete ornamental frame and contain a
real design note. The prose must occupy at least four substantive comment lines
and normally stays within four to eight. Blank lines and `@docs/` references do
not count.

```text
// ── Phase Advancement Requires A Validated Handoff ───────────────
// Each phase owns a private Codex process and gateway that must not overlap
// with its successor. A handoff records the requested transition, but does not
// authorize the next phase by itself. The host first validates its target and
// artifact, then waits for the current process and gateway to exit. Only after
// both conditions hold may the successor start, preserving single-phase
// ownership even when shutdown or validation fails.
//
// @docs/user-guide/workflows.md
// ─────────────────────────────────────────────────────────────────
```

Opening and closing separators are mandatory. Replace only the comment prefix
for another language. Never substitute a bare heading or region marker.

### Rules

- Add a section only where prose changes understanding: domain rules, trust or
  validation transitions, algorithms, lifecycle, concurrency, compatibility,
  performance, cleanup, retries, cancellation, or degraded behavior.
- Do not wrap trivial declarations, accessors, or self-explanatory helpers.
- Make the title a precise design claim, not `Helpers`, `Utilities`, or `Logic`.
  Use the same title for the same concept wherever it reappears.
- Cover the context that makes the section necessary, the decision embodied by
  the code, and the invariant or failure mode it protects. Do not paraphrase the
  next function or list implementation steps.
- Make every claim provable by nearby code, types, schemas, assertions, tests,
  or an explicit review condition. Prose that disagrees with code is a defect.
- Keep the source understandable locally. When wider context exists, add one
  dedicated `@docs/<path>.md` line per document inside the frame. The path after
  `@` is repository-root-relative and must exist.
- Update code, prose, tests, and linked docs together. Remove stale notes.
- AI agents must not invent intent, add filler, or overstate guarantees.

## 05. TypeScript

Use TypeScript types for compile-time states and values. Validate all I/O,
storage, process, environment, and network input at runtime.

### Type Modeling

- Do not use `any`. Accept `unknown` at untrusted boundaries and narrow it with
  schemas or explicit type guards.
- Prefer inference. Add explicit annotations and interfaces only for exports,
  recursive types, boundary contracts, or genuine clarity.
- Model mutually exclusive states with discriminated unions instead of optional
  fields or clusters of booleans.
- Make switches over closed unions exhaustive. A newly added variant must cause
  a type error at every decision point that has not considered it.
- Prefer `satisfies` when checking a value against a contract without widening
  its inferred type. Use `as const` only to preserve meaningful literal values.
- Type assertions and non-null assertions require a nearby proof the compiler
  cannot express. Do not use them to silence an unresolved boundary.
- Keep public input types permissive only where compatibility requires it;
  normalize immediately into a smaller internal type.

### Modules

- Do not add barrel exports that create cycles or expose internal symbols unused
  outside the module.
- Do not create an interface that merely mirrors one concrete class. Add one
  only when a consumer needs multiple implementations or an external boundary.
- Pass dependencies explicitly through function arguments, constructors, or
  Effect layers. Do not use mutable module globals, hidden singletons, or service
  locators.
- Do not introduce circular imports.
- In `src/config`, preserve the established self-export convention when adding a
  module.

### Control Flow And Data Transformation

- Prefer `const`, early returns, and ternaries over reassignment and `else`.
- Preserve object context with dot notation; avoid unnecessary destructuring.
- Inline values used once when doing so keeps the expression readable.
- Prefer `map`, `filter`, `flatMap`, and typed predicates over mutable loops when
  they express the transformation directly. Use a loop when it makes early exit,
  stateful accumulation, or performance constraints clearer.
- Keep the main function on the happy path. Move several validation branches or
  complex supporting details into nearby, honestly named helpers.
- Avoid boolean parameters whose call sites hide meaning. Use a named options
  object or separate operations when the modes have distinct semantics.
- Keep ESM imports explicit and use established path aliases. Do not add
  CommonJS compatibility code without a demonstrated runtime requirement.

### Async Work, Errors, And Resources

- Do not leave floating promises or use an async callback with `forEach`. Await
  work directly or collect it into an explicit concurrency operation.
- Run independent bounded work concurrently with `Promise.all` or the owning
  Effect combinator. Keep ordered, rate-limited, or state-dependent work
  explicitly sequential.
- Long-running operations must accept an `AbortSignal`, run in a scoped Effect,
  or be cancelled explicitly by their owning process.
- Catch an error only to recover, add actionable context, translate it at a
  boundary, or release a resource. Preserve the original cause and never swallow
  an unexpected failure.
- Keep synchronous parsing, validation, and option construction outside Effect.
  Do not return `Effect` from a helper that performs no effectful work.
- For untrusted JSON handled with Effect, prefer `Schema.UnknownFromJsonString`
  and `Schema.decodeUnknownOption` over manual `JSON.parse` in `Effect.try`.
- Effect resources must use a scoped lifetime or explicit finalizer. Preserve
  typed failures until the boundary responsible for rendering or transport.
- Throw `Error` values, not strings or arbitrary objects. If callers must branch
  by failure type, expose a typed failure instead of requiring message parsing.
- Do not share mutable state across concurrent operations without one explicit
  owner and serialized transitions.
- Cleanup must be idempotent when cancellation, process exit, and normal
  completion can race.

## 06. Bun

- Bun is the primary runtime for the root workspace and `cyberful/` package.
- In files executed only by Bun, prefer `Bun.file`, `Bun.write`, `Bun.spawn`, and
  `Bun.Glob` over equivalent Node wrappers.
- Pass subprocess arguments as arrays. Consume required output streams and await
  process exit; do not leave detached children without an explicit owner.
- Do not use synchronous filesystem or subprocess APIs on event-processing or
  protocol paths.

## 07. Node.js And JavaScript

- Node-compatible MCP code under `mcps/` must remain ESM and use `node:` imports
  for built-in modules.
- Do not introduce Bun-only APIs into code executed by the host Node.js runtime.
- Keep stdout protocol-clean for MCP and JSON-line processes. Send diagnostics to
  stderr and make shutdown on EOF, `SIGINT`, and `SIGTERM` explicit.
- Use argument arrays instead of shell command strings for child processes.
  Validate environment input before it affects paths, commands, ports, or policy.
- Plain JavaScript must use runtime validation where TypeScript would otherwise
  have enforced a boundary.

## 08. Python

Python source must support the version declared in the requirements guide.

### Types And Module Boundaries

- Type public functions, boundary data, and non-obvious return values.
- Use `Any` only while handling unvalidated protocol or external data. Narrow it
  before passing the value into internal logic.
- Use a dataclass for a fixed record passed between functions. Use dictionaries
  for dynamic JSON objects, not as unnamed internal records.
- Never use mutable default arguments. Create mutable values inside the function
  or with a default factory.
- Keep import-time work limited to definitions, constants, and compiled patterns.
  Start processes, read input, and mutate external state only from an explicit
  entry point guarded by `if __name__ == "__main__"`.
- Use explicit imports. Do not use wildcard imports or mutate another module's
  globals.

### Input, Files, And Errors

- Validate decoded JSON and environment values by type, allowed values, and size
  before use. Clamp configurable timeouts and output limits at their boundary.
- Catch named exceptions. A broad `except Exception` is allowed only at the
  outer protocol boundary that converts an unknown failure into an error reply.
- Never use a bare `except`, silently discard an exception, or return success
  after a failed operation.
- When translating an exception, preserve its cause with `raise ... from ...`
  unless the function returns a protocol error instead of raising.
- Open text files with an explicit encoding and error policy.
- Resolve and validate caller-controlled paths before reading or writing. Prove
  containment when a path must remain inside a workspace or output directory.
- Use `time.monotonic()` for elapsed time, deadlines, and timeout calculations.

### Subprocesses And Protocols

- Invoke subprocesses with argument lists and `shell=False`. Shell execution is
  allowed only when shell syntax is the explicit input contract.
- Every subprocess must have an explicit timeout or a documented long-running
  owner with cancellation and cleanup.
- Set `check`, captured streams, text decoding, and environment behavior
  explicitly. Do not rely on `subprocess` defaults at a security boundary.
- Bound captured output before retaining it or returning it through MCP. Decode
  untrusted process output with an explicit error policy.
- Forward only the environment required by the child when it does not need the
  complete host environment. Never forward credentials accidentally.
- Keep stdout machine-readable for MCP and JSON-line processes. Send diagnostics
  and progress logs to stderr.
- Include the exit code and bounded stderr in command failures without exposing
  secrets.

### Resources And Tests

- Use context managers or `finally` for files, selectors, temporary resources,
  and process streams.
- On cancellation, terminate the child, escalate to kill after a bounded wait,
  and reap it. Cleanup must be safe when called more than once.
- Python tests use `unittest` and real temporary directories.
- Mock only an external boundary such as `subprocess`; do not mock the function
  or validation rule under test. Assert the command, environment, timeout, and
  translated result at that boundary.
- Unit tests must not depend on the developer's home directory, external
  daemons, network, wall-clock time, or mutable module state.
- Cover malformed input, boundary values, subprocess timeout, non-zero exit,
  output truncation, and cleanup for code that owns those behaviors.

## 09. Testing

- Every test must protect a routine user action, an externally observable
  behavior, a regression, or a runtime contract exercised in production.
- Prefer scenarios users actually perform: starting the application, loading
  configuration, creating or resuming a session, advancing a phase, calling a
  tool, handling a failure, and exiting without leaked resources.
- Do not add tests only to increase coverage, assert a constant, mirror the
  implementation, or freeze private call order and object layout.
- Test observable behavior through the real implementation. Avoid mocks unless
  the real boundary is unavailable, unsafe, or belongs to an external system.
- Every bug fix must add or strengthen a test that fails for the original defect
  when such a test is technically possible.
- Do not replace live contract tests with duplicated simulations. MCP, network,
  process cleanup, and Codex compatibility behavior require their existing
  integration tiers.
- Tests must close clients, servers, databases, files, processes, and other
  external resources they create. Intermittent failures are defects, not
  candidates for retries.
- Name tests after observable behavior, not the implementation function.
- Test failure and cancellation paths when they can mutate state or leak a
  resource.
- A passing test must not print routine logs, progress, subprocess output, or
  expected errors. Capture them and reveal only the context needed when an
  assertion fails.
