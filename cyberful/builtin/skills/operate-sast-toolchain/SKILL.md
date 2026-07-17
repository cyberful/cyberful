---
name: operate-sast-toolchain
description: Operate Semgrep and source-oriented static analysis as a hypothesis, coverage, and regression system during advanced code audits. Use for repository baselining, custom rule authoring, taint/dataflow searches, framework-specific sink discovery, variant analysis, diff review, scanner reconciliation, SARIF production, or when generic rules miss project-specific security invariants.
---

# Operate SAST Toolchain

Use static analysis to index risk and scale a known reasoning pattern. A finding becomes meaningful only after reachability, data/control flow, authority, and runtime configuration are established.

## Build the scan manifest

Record commit, languages, parsers, generated/vendor/build directories, submodules, ignored files, file counts/bytes by language, ruleset identity/hash, Semgrep version, command, timeout, memory, and parse errors.

Run a parser/coverage pass before a security pass. A clean result over 40% of the security-relevant source is not a clean repository.

## Layer the rules

1. **Syntax anchors:** dangerous APIs, control definitions, route handlers, deserializers, loaders, process/network/file sinks.
2. **Project abstractions:** wrappers, builders, helper methods, middleware, decorators, policy functions, generated clients.
3. **Local taint:** untrusted sources to sinks with sanitizers and propagators.
4. **Security invariants:** privileged operation without required dominating check, tenant identifier replaced downstream, unsafe fallback, missing state transition.
5. **Variants:** generalize a confirmed bug by semantic mechanism, not copied token.

Read [references/semgrep-fieldbook.md](references/semgrep-fieldbook.md) when designing rules or interpreting coverage.

## Run reproducibly

Use the dedicated semgrep tool with:

- scan subcommand;
- local pinned rule files/directories;
- --metrics=off;
- explicit target roots and excludes;
- JSON or SARIF output under the workarea;
- controlled jobs, timeout, max-target-bytes, and error behavior.

Keep broad discovery output separate from release-gating output. Baselines suppress historical results for triage; they do not prove historical code safe.

## Validate every custom rule

Create minimal positive, negative, near-miss, and sanitizer fixtures. Include aliasing, wrapper, alternate syntax, async/callback, and language-version cases relevant to the repository. Run the rule against fixtures before the product tree.

For each match:

1. locate production entry point;
2. trace values and authority across wrappers and storage;
3. identify dominating validation/authorization;
4. inspect configuration and dependency behavior;
5. classify reachability and effect;
6. search for siblings from both source and sink directions.

## Diagnose negatives

A zero-match rule may mean:

- wrong language/parser;
- files excluded or too large;
- syntactic shape differs;
- wrapper hides source/sink;
- interfile/interprocedural flow exceeds the engine model;
- sanitizer definition over-matches;
- framework generated code owns the path;
- data is stored and consumed in another process;
- runtime reflection or dynamic dispatch defeats static resolution.

Use search, call hierarchy, runtime tests, and manual tracing to close these gaps.

## Deliver

Preserve scan manifest, raw output, parse/timeout/errors, rules and tests, triage decisions, confirmed paths, rejected matches, coverage ledger, and systemic variants. A suppression must state whether it is unreachable, controlled, accepted, duplicate, test-only, or scanner limitation.
