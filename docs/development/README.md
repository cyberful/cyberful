# Build Cyberful with us

Contributions are welcome. Cyberful exists to democratize cybersecurity: more
developers and curious builders should be able to understand risk, verify a
finding, and improve a system. We do that without weakening authorization,
privacy, isolation, or evidence quality.

Before editing code, read these repository contracts in order:

1. [`CODE.md`](https://github.com/cyberful/cyberful/blob/main/CODE.md), the mandatory code-writing canon;
2. [`AGENTS.md`](https://github.com/cyberful/cyberful/blob/main/AGENTS.md), the repository workflow and runtime contract;
3. [`mcps/AGENTS.md`](https://github.com/cyberful/cyberful/blob/main/mcps/AGENTS.md) for changes under `mcps/`.

Install dependencies with `make deps` and keep the change focused. Behavior,
configuration, phase contracts, tools, and event semantics require
documentation in the same change.

```sh
make typecheck
make test-bun
make test-python
make docs-build
```

Run Docker, network, ZAP, and Codex contract tiers when the affected boundary
requires them. Treat new type errors and runtime warnings as defects. Add a
regression test whenever a defect is technically reproducible. Regenerate the
control-plane client with `bun run --cwd cyberful generate-client` only when its
schema changes.

Before opening a pull request, confirm that no secrets, engagement evidence,
reports, transcripts, profiles, or runtime state are included; that relevant
tests pass; and that redistributed code or assets have compatible provenance
and notices. Pull-request titles use conventional commit form because the
release planner reads the squash title.

Follow the repository
[Code of Conduct](https://github.com/cyberful/cyberful/blob/main/CODE_OF_CONDUCT.md).
Report vulnerabilities through the private process in
[`SECURITY.md`](https://github.com/cyberful/cyberful/blob/main/SECURITY.md),
never in a public issue.
