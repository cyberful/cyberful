# Cyberful Agent Instructions

Cyberful is a Pi Agent-backed application-security workbench. The repository root is the Bun/TypeScript workspace; its application package lives under `cyberful/` and provides the terminal control plane, session storage, Pi phase orchestration, gateway lifecycle, handoffs, and reporting. The `mcps/` collection provides cyberful-os, the isolated browser, and the headless OWASP ZAP runtime and bridge.

First-party phase personas, budgets, skills, instructions, and MCP policy live under `cyberful/builtin/` and are embedded into release binaries.

## Build, test, and run

From the repository root:

- `make deps` — install workspace and MCP dependencies.
- `make typecheck` — type-check every workspace package.
- `make build` — build standalone binaries for all platforms.
- `make install` — build and install the `cyberful` command for the current system.
- `make run` — launch Cyberful with the repository root as its workspace.
- `make docs` / `make docs-build` — serve or build the engineer docs.

When working under `mcps/`, follow [`mcps/AGENTS.md`](mcps/AGENTS.md).

## Runtime contract

Pentest uses Pi Agent as its runtime. Its chain is:

`brief -> recon -> exploit -> hacker -> verify -> report`

Bug Bounty Program also uses Pi Agent, with a dedicated Brief, Verify, and Report around the shared Pentest Recon, Exploit, and Hacker personas. Its chain is:

`brief -> recon -> exploit -> hacker -> verify -> report`

Code Audit is read-only with respect to the user checkout. Its chain is:

`scope -> index -> trace -> hunt -> attack -> verify -> report`

Code Audit keeps external target traffic disabled. Attack and Verify may use a phase-owned disposable lab: dependency bootstrap sees manifests only, project execution is offline and loopback-only, and the mutable lab is destroyed when the gateway closes.

Each sequential phase owns one fresh phase-scoped in-process Pi worker owner and a private host gateway. Root, delegated, and fallback `AgentRun` instances are separate Pi contexts inside that owner. Phase advancement requires a validated `handoff`; the owner must shut down and the gateway must exit before the successor starts. Only the original phase root owns `handoff`. Persona `subagents` metadata and the limits in `settings.yaml` bound nested delegation. A fallback is a complete `AgentRun`, but its whole descendant tree remains affined to the configured fallback provider. Do not introduce host-owned phase fan-out, hidden delegation, or another unconstrained model execution route.

## Operational constraints

- Cyberful is an authorized application-security workbench. Keep work inside the scope supplied by the user or engagement artifacts.
- No component may emit outbound telemetry, metrics, or analytics.
- Keep auxiliary services hardened and localhost-only. Target traffic through the approved browser, proxy, and cyberful-os paths is expected.
- Never commit credentials, session transcripts, workareas, browser profiles, ZAP state, or generated reports.

## Code principles

[`CODE.md`](CODE.md) is the mandatory code-writing canon for humans and agents. It governs universal design, literate sections, TypeScript, Bun, Node.js, Python, and tests. Read the universal, literate, and applicable technology sections before changing source.

This file adds repository workflow and runtime constraints. It does not relax or duplicate the code canon.

## Repository workflow

Preserve user changes in a dirty worktree. Prefer additive, narrowly scoped changes and avoid unrelated rewrites. Use `rg` for repository searches and `apply_patch` for manual file edits. Treat new TypeScript errors and new runtime warnings as defects.

- To regenerate the internal control-plane client, run `bun run --cwd cyberful generate-client`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `main`.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## Working narration

Make work legible while it happens:

- state the intent before a group of tool calls or edits;
- surface key decisions and risks without transcribing hidden reasoning;
- summarize each completed block and say what verification follows;
- do not leave the user without a progress update during extended work.

## Skills and hooks

Skills and hooks are shared repository behavior. When adding, changing, renaming, or deleting one, inventory matching registrations under `.claude/`, `.agents/`, and `.codex/`; keep shared content aligned; remove stale copies and registrations; and verify deliberate adapter differences.

## Documentation

Do not hard-wrap Markdown prose. Keep each paragraph and each list item on one physical line unless a line break is required by Markdown syntax, embedded HTML structure, a code block, a table, or an intentional hard break.

The engineer site under `docs/` is a first-class maintenance target. Update it in the same change whenever behavior, configuration, phase contracts, tools, or event semantics change. Describe the present system, not migration history. Keep pages self-contained and add published pages to `mkdocs.yml`.

Keep [`docs/runtimes/tool-catalog.md`](docs/runtimes/tool-catalog.md) complete and current whenever a Pi-native tool, gateway tool, MCP server or tool, runtime CLI or library wrapper, ZAP extension, version pin, availability rule, name, description, or use case changes. Reconcile its names and counts against the executable registries, distinguish pinned versions from locally build-resolved versions, and verify the catalog through the documentation build in the same change.

Keep [`README.md`](README.md) aligned when a change affects components, setup, commands, or user-facing behavior.
