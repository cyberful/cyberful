# Cyberful

Cyberful turns your AI coding agent into an ethical hacker for authorized
penetration testing, deep code auditing, and bug bounty hunting.

<p align="center">
  <img src="docs/assets/cyberful-demo.gif" alt="Cyberful running an authorized penetration test" />
</p>

Cyberful combines coding agent-driven security reasoning with isolated offensive
tooling, a local Code Graph, independent verification, durable evidence, and
report-ready outputs. It has three security workflows:

| Workflow | Use it for | Phase chain | Primary result |
| --- | --- | --- | --- |
| **Pentest** | An authorized live target | Brief → Recon → Exploit → Hacker → Verify → Report | `reports/security-report.pdf` |
| **Bug Bounty Program** | An authorized target governed by a supplied bounty policy | Brief → Recon → Exploit → Hacker → Verify → Report | `BUG_BOUNTY_REPORT.md` and per-finding submissions |
| **Code Audit** | A repository, branch diff, architecture, controls, dependencies, build, and local runtime | Scope → Index → Trace → Hunt → Attack → Verify → Report | `reports/code-audit-report.pdf` |

After any workflow completes, **Ask** provides follow-up answers against the
same workarea and evidence without expanding its scope.

## Getting started

Cyberful requires an authenticated Codex CLI and Docker. Install the validated
Codex version, authenticate, then launch Cyberful:

```sh
npm install --global @openai/codex@0.144.5
codex login

npm install --global @cyberful/cli
cyberful
```

For a source checkout:

```sh
make deps
make run
```

Choose a workarea, select Pentest, Bug Bounty Program, or Code Audit, and
describe the objective. Pentest requests must include the exact authorized targets, exclusions, and
traffic constraints. Bug Bounty requests should also supply the official program
policy as text, an attachment, or an exact public URL. Code Audit requests may
name the complete repository or explicitly request review of a branch, commit
range, or current Git changes.

See [Your first penetration test](docs/getting-started/README.md) and
[Choose a workflow](docs/user-guide/workflows.md).

## Pentest

Pentest uses one authorized mission across six fresh Codex processes:

```text
brief → recon → exploit → hacker → verify → report
```

Brief fixes the authorization boundary. Recon maps the target. Exploit performs
systematic, reproducible validation. Hacker investigates unconventional chains
and assumptions. Verify independently retests claims. Report produces the
client-facing PDF.

The workflow can use cyberful-os, the isolated browser, and headless OWASP ZAP.
Bounded reversible tests inside the recorded mission run autonomously;
irreversible, disruptive, value-moving, cross-scope, or uncontrolled-user
actions require a human decision.

## Bug Bounty Program

Bug Bounty Program uses the same live-target Recon, Exploit, and Hacker phases
as Pentest. Its dedicated Brief records the supplied program policy, safe
harbor, eligible assets and vulnerability classes, prohibited testing, data
handling, and disclosure rules in the compatible `MISSION.md` contract.

Verify independently retests every candidate and classifies it as
`SUBMISSION_READY`, `NEEDS_MORE_EVIDENCE`, or `NOT_REPORTABLE`. Report creates
one portable Markdown submission per ready finding under
`reports/bug-bounty/BBP-###.md` and a terminal `BUG_BOUNTY_REPORT.md` index. It
does not submit to a platform, search private duplicate databases, predict
acceptance, or estimate rewards.

## Code Audit

Code Audit is read-only with respect to the user's checkout and covers more
than suspicious source lines:

```text
scope → index → trace → hunt → attack → verify → report
```

- **Scope** fixes the source snapshot and selects a full-repository or explicit
  diff lens. It maps components, identities, assets, trust boundaries,
  deployment variants, dependencies, build and release authority.
- **Index** builds and quality-checks the complete local Code Graph. Diff audits
  still index the repository so callers, callees, guards, schemas, tests, and
  release paths remain in the blast radius.
- **Trace** converts threats and unacceptable outcomes into sources, sinks,
  controls, negative tests, and producer-to-runtime paths.
- **Hunt** examines application, native, cryptographic, smart-contract,
  agentic-AI, cloud, firmware, supply-chain, CI/CD, and business-logic risks
  relevant to the repository.
- **Attack** attempts to run the project in a disposable local lab and turns
  the strongest hypotheses into controlled runtime evidence.
- **Verify** starts with a fresh context and lab, tries to refute every
  candidate, and alone may mark it confirmed or dismissed.
- **Report** renders the verified result, coverage, limitations, remediation
  guidance, SARIF, and structured evidence.

The terminal artifacts are:

```text
reports/code-audit-report.pdf
CODE_AUDIT_REPORT.md
reports/code-audit.sarif
reports/code-audit-evidence.json
```

### Full and diff audits

A full audit is the default. When the objective explicitly requests a branch,
commit range, or current changes, Scope seals an offline Git diff. The diff
tool never fetches, runs hooks or repository filters, inherits credentials, or
modifies the checkout. It records the merge base, head, dirty/untracked state,
changed paths, patch digest, and exact evidence paths under
`raw/code-audit/diff/`.

### Disposable runtime lab

Attack and Verify automatically prepare a local lab when feasible:

1. Cyberful copies only recognized manifests and lockfiles into a disposable,
   credential-free bootstrap container.
2. Dependencies are downloaded with lifecycle scripts disabled where the
   package manager supports it. The container has CPU, memory, PID, capability,
   and privilege limits and is destroyed when bootstrap ends.
3. Only after networked bootstrap exits does the host materialize the sealed
   source snapshot under the workarea.
4. Project build, startup, tests, and attacks run offline inside the phase-owned
   cyberful-os container, against loopback services only.
5. The phase container and mutable lab tree are destroyed at phase exit;
   retained evidence stays under `raw/code-audit/`.

Automatic adapters cover common Node.js, Python, Go, Rust, PHP Composer, Ruby
Bundler, and Maven manifests when the matching runtime exists in cyberful-os.
Unsupported build systems or missing fixtures are reported as explicit coverage
limitations; they never cause fallback to an external deployment.

## Execution and evidence contract

Every sequential phase owns one fresh Codex app-server process and private host
gateway. It must write its required artifact and request the exact successor
through `handoff`. The host validates and seals the artifact, stops the current
process and gateway, and only then starts the next phase.

If a phase exhausts its active-time budget, Cyberful advances in degraded mode
only when the required partial artifact can be sealed and cleanup succeeds.
Missing artifacts, invalid handoffs, failed integrity gates, and incomplete
cleanup halt the chain. Blocking human questions pause the phase deadline and
process group until answered or rejected.

Durable context lives in the workarea, transcripts, and Code Graph—not hidden
conversation state. Repository instructions, documentation, comments, web
content, and tool output are treated as untrusted evidence.

Code Audit candidates enter a host-attested ledger as `suspected`. Hunt and
Attack may create candidates; Verify owns transitions to `confirmed` or
`dismissed`; Report is read-only. The host exports both SARIF and structured
evidence from the validated ledger.

## Architecture

- `cyberful/src/` — TUI, sessions, workflow orchestration, source store,
  gateway lifecycle, Code Graph, handoffs, reporting, and cleanup.
- `cyberful/builtin/` — embedded first-party personas, budgets, instructions,
  skills, and MCP policy.
- `mcps/cyberful-os/` — isolated offensive and analysis toolchain.
- `mcps/browser/` — dedicated Chromium automation.
- `mcps/zap/` — headless OWASP ZAP runtime and bridge for live-target workflows.

Codex is the primary backend. An operator may attach a pre-started loopback
Responses server as an optional local delegate. The primary can invoke it
serially whenever an authorized operation needs a more aggressive approach that
the primary cannot execute; the host may also run one automatic recovery after
a recoverable primary failure. It inherits the same scope, workarea, controls,
approval ledger, and remaining budget, and is not a replacement backend.

Cyberful emits no outbound telemetry, metrics, or analytics.

## Requirements

- Bun 1.3.14 or compatible for source builds
- the Codex CLI version declared in `cyberful/src/dependency/codex.ts`
- Docker with Compose
- Python 3.10+ for cyberful-os host control
- Node.js 18+ for the npm launcher and browser MCP

See the [requirements guide](docs/getting-started/requirements.md) for macOS,
Linux, and Windows setup.

## Build and test

From the repository root:

```sh
make deps        # install workspace and MCP dependencies
make typecheck   # run source policy checks and TypeScript checks
make test        # run Bun/Python tests and live container contracts
make test-all    # include loopback, ZAP, and Codex contracts
make build       # build standalone binaries
make install     # build and install for the current system
make run         # launch from source
make docs        # serve the engineer documentation
make docs-build  # build the documentation site
```

The installed binary embeds `cyberful/builtin/`. Source runs read that directory
directly, so persona and skill edits take effect without rebuilding.

## Configuration and local state

Environment variables are documented in [`.env-example`](.env-example). Shell
variables take precedence over a `.env` in the launch directory, which takes
precedence over build defaults.

Workareas live under `work/<name>/`; session transcripts live under
`logs/session-logs/`. Imported repositories and authoritative snapshots live in
an owner-only host source store outside the model-writable workarea. Never place
secrets directly in prompts or commit generated workareas, transcripts, browser
profiles, ZAP state, or reports.

Resume from the same launch directory:

```sh
cyberful run --continue
cyberful run --session <id>
```

## Documentation

- [Requirements](docs/getting-started/requirements.md)
- [Workflow guide](docs/user-guide/workflows.md)
- [Terminal interface](docs/user-guide/interface.md)
- [Sessions, configuration, and reports](docs/user-guide/sessions-and-reports.md)
- [Architecture](docs/concepts/architecture.md)
- [Execution model](docs/concepts/execution-model.md)
- [Security runtimes](docs/runtimes/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License and responsible use

Cyberful is released under the [Apache License 2.0](LICENSE). Use it only on
systems and source you are authorized to assess. You are responsible for scope,
authorization, legal compliance, and safe operation.
