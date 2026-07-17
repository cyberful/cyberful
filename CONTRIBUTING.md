# Contributing To Cyberful

Cyberful accepts changes to the terminal workbench, Codex phase subsystem,
first-party configuration, MCP tooling, container runtimes, tests, and engineer
documentation. Contributions must preserve the authorized-security boundary,
localhost-first service posture, and zero-telemetry policy.

The extended contributor guide starts at
[`docs/development/README.md`](docs/development/README.md).

## Read Before Changing Code

Three documents form the contribution contract:

1. [`CODE.md`](CODE.md) is the mandatory code-writing
   canon for humans and AI agents.
2. [`AGENTS.md`](AGENTS.md) defines repository workflow and runtime constraints.
3. [`mcps/AGENTS.md`](mcps/AGENTS.md) adds instructions for work under `mcps/`.

Directory-level instructions add narrower constraints; they do not replace the
root code principles.

## Prepare The Workspace

Install the supported tools from the
[requirements guide](docs/getting-started/requirements.md), then install dependencies:

```sh
make deps
```

Inspect the worktree before editing. Do not discard, overwrite, or reformat
unrelated changes already present.

## Make A Change

- Keep the patch narrow and give one component clear ownership of the behavior.
- Follow every applicable section of `CODE.md`. Every added or
  functionally changed code file needs a current ornamental file header contract;
  non-obvious internal sections follow the compact Literate Code rules.
- Add or strengthen tests for changed behavior.
- Update `docs/`, `mkdocs.yml`, and `README.md` when their contracts or entry
  points change.
- Regenerate derived files from their source rather than editing generated
  output by hand.
- Never add credentials, engagement data, transcripts, reports, browser state,
  databases, caches, container state, or telemetry.

## Verify The Change

Use the smallest relevant checks while iterating, then run every tier affected
by the final change:

```sh
bun run --cwd cyberful check:code
make typecheck
make test-bun
make test-python
make docs-build
```

The first command is the fast repository-wide `CODE.md` conformance gate;
`make typecheck` runs it again before compiling TypeScript.

Docker, network, ZAP, and Codex changes require their corresponding integration
targets. See [Build Cyberful with us](docs/development/README.md)
for the full verification matrix and
[Testing and CI](docs/development/testing.md) for CI behavior.

If a required tier cannot run locally, state exactly what was not run and why.
Do not describe an unexecuted check as passing.

## Submit For Review

A review-ready change explains the owned behavior, important constraints, tests
actually run, documentation affected, and any remaining risk. The complete
review gates are in the
[contributor checklist](docs/development/README.md).

## License Of Contributions

Unless explicitly agreed otherwise in writing, every contribution intentionally
submitted to Cyberful is licensed under the GNU Affero General Public License
version 3 only (`AGPL-3.0-only`). Contributors must have the legal right to
submit their work and must identify any third-party material it contains.
