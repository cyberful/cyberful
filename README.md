# Cyberful

[![CI](https://github.com/cyberful/cyberful/actions/workflows/ci.yml/badge.svg)](https://github.com/cyberful/cyberful/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/cyberful.svg)](https://www.npmjs.com/package/cyberful)
[![Documentation](https://img.shields.io/badge/docs-cyberful.io-1463ff.svg)](https://cyberful.io/)

Cyberful turns your AI coding agent into an ethical hacker for authorized
penetration testing, deep code auditing, and bug bounty hunting.

<p align="center">
  <img src="docs/assets/cyberful-demo.gif" alt="Cyberful running an authorized penetration test" />
</p>

Cyberful combines coding agent-driven security reasoning with isolated offensive
tooling, a local Code Graph, independent verification, durable evidence, and
report-ready outputs. It has three security workflows:

| Workflow               | Use it for                                                                                | Phase chain                                             | Primary result                                     |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| **Pentest**            | An authorized live target                                                                 | Brief → Recon → Exploit → Hacker → Verify → Report      | `reports/security-report.pdf`                      |
| **Bug Bounty Program** | An authorized target governed by a supplied bounty policy                                 | Brief → Recon → Exploit → Hacker → Verify → Report      | `BUG_BOUNTY_REPORT.md` and per-finding submissions |
| **Code Audit**         | A repository, branch diff, architecture, controls, dependencies, build, and local runtime | Scope → Index → Trace → Hunt → Attack → Verify → Report | `reports/code-audit-report.pdf`                    |

After any workflow completes, **Ask** provides follow-up answers against the
same workarea and evidence without expanding its scope.

## Getting started

Cyberful includes the Pi Agent runtime and requires Docker. Install Cyberful,
authenticate the default OpenAI Codex provider through Cyberful, then launch
the terminal:

```sh
npm i -g cyberful
cyberful auth login
cyberful
```

The first run pulls one native `amd64` or `arm64` tooling image. The download
can exceed 6 GB; keep at least 40 GB of disk space free. A standalone binary
needs Docker as its only host tooling prerequisite; the npm channel also needs
Node.js and npm for its platform selector. ZAP, Ghidra, Python, Firefox, and
Kali tools are inside the image.

For a new macOS, Linux, or Windows host, follow [Your first penetration
test](docs/getting-started/README.md) to install every prerequisite,
authenticate the provider, verify the environment, and run the workflow.

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

Read the complete documentation at [cyberful.io](https://cyberful.io/), then
start with [Your first penetration test](docs/getting-started/README.md) or
[Choose a workflow](docs/user-guide/workflows.md).

## Motivation

Large language models have brought powerful new capabilities into software
creation and analysis, but also a persistent sense of uncertainty around
cybersecurity. Their behavior can feel opaque, their dual-use potential is real,
and the conversation often collapses into extremes: harmless assistants on one
side, uncontrollable offensive systems on the other. That ambiguity leaves many
people unable to judge what is secure, what is merely plausible, and what
evidence should be trusted.

Fear grows when security knowledge, tools, and validation methods remain
accessible only to a small group of specialists. Attackers do not wait for the
rest of the ecosystem to become comfortable with new technology; defenders,
maintainers, researchers, and smaller teams need practical ways to understand
their exposure now. We believe **democratizing cybersecurity** is therefore part
of mitigating the risks created or amplified by widespread AI adoption. The
same technology that raises concern can help close the defensive gap when it is
placed inside explicit boundaries and rigorous workflows.

Broader access to security capabilities helps more people ask better questions,
reproduce findings, distinguish suspicion from a verified vulnerability, and
act on evidence rather than mystique. Making it easier to understand why a
system is secure—or why it is not—is essential to informed decisions, effective
remediation, and justified trust.

Democratization does not mean unrestricted automation or lower safety standards.
It means making advanced security work understandable, inspectable, and usable
within explicit authorization and policy constraints. Cyberful pursues that
goal through open-source code, visible orchestration, isolated execution,
durable evidence, and independent verification gates. The aim is not to make
cybersecurity look simple, but to make its complexity navigable.

## Pentest

Pentest uses one authorized mission across six fresh in-process Pi phase owners:

```text
brief → recon → exploit → hacker → verify → report
```

Brief fixes the authorization boundary. When existing browser accounts were
supplied, it first verifies each target session, distinct identity, and ZAP
routing. If stored access is sufficient, Brief completes the normal login
autonomously through host-resolved variable references; it asks **OK, retry**
only for a human-only challenge or access, profile, or proxy failure. Broken
profiles prevent a final `MISSION.md`. It records passively observed application dependencies for
downstream reasoning without treating them as direct testing targets or blocking Recon.
Pentest and Bug Bounty Brief write the same prerequisite matrix with separate
readiness and scope states. The matrix is an authorization floor, not a finite
test list: later phases add new surfaces and hypotheses dynamically, while
`UNRESOLVED` can suspend only one evidenced action/asset pair. Recon maps the target,
separates concrete anomalies and target-specific seams from retained coverage ideas, and records probability,
impact, positive evidence, contrary evidence, and discriminating tests independently. Exploit performs
systematic, reproducible validation. Hacker investigates unconventional chains and
assumptions. Verify independently retests claims. Report produces the
client-facing PDF, with a finding-specific, evidence-backed, secret-safe proof of
concept for every confirmed issue. Tagged request and code blocks are syntax
coloured and line-numbered for practical reproduction.

Brief also installs the engagement's aggregate HTTP rate limit in its live ZAP
runtime before committing the non-secret engagement policy. A failed
installation leaves no new policy behind, blocks handoff, and returns a
sanitized non-retryable host diagnostic instead of sending the agent into an
operator-approval loop.

The workflow can use cyberful-os, the isolated browser, headless OWASP ZAP, and
a persistent headless Ghidra project during Recon through Verify.
ZAP exposes its complete discovered API and official MCP surface without a
second host-owned origin or operation policy; `MISSION.md` remains the
authoritative scope boundary.
Bounded tests using tester-owned or uniquely marked synthetic state inside the
recorded mission run autonomously. Cleanup is attempted when the target exposes
a supported mechanism; the absence of cleanup for one residual synthetic record
does not by itself require a human decision. Persistent code or retained reusable
access, disruptive, value-moving, cross-scope, or uncontrolled-user actions do.
Exploit and Hacker subagents inherit that same authority and own their bounded
tests through a verdict; they are not passive-only advisory workers.

## Bug Bounty Program

Bug Bounty Program uses the same live-target Recon, Exploit, and Hacker phases
as Pentest. Its dedicated Brief records the supplied program policy, safe
harbor, eligible assets and vulnerability classes, prohibited testing, data
handling, and disclosure rules in the compatible `MISSION.md` contract.

Its three research phases reserve part of their reasoning budget for
target-specific unknown-unknown exploration. One host-owned hypothesis registry
tracks stable questions, owners, tests, evidence, phase transfers, finding
links, and final dispositions. The same registry serves Pentest and Code Audit;
Bug Bounty additionally requires a qualitative contrarian synthesis.

Bug Bounty uses 30 minutes for Brief, 60 for Recon, 120 each for Exploit and
Hacker, 180 for Verify, and 90 for Report. Pentest uses the same 60/120/120
research budgets. Provider wait can extend each research phase by at most one
shared 15-minute pool; explicit human approval wait is tracked separately.
Novelty remains qualitative: convergence triggers a contrarian pivot, not a
quota, while browser surface coverage steers the phases toward unvisited real
journeys. Every `READY` and `IN_SCOPE` profile must reach its origin and perform
one meaningful action, without arbitrary click or route quotas.

Bug Bounty can also import up to eight approved HTTPS repositories at exact
commits during Brief or Recon, including recursive submodules at their Gitlink
commits. Recon through Verify can preserve binary imports, analysis, decompiled
functions, call graphs, names, comments, and bookmarks in one headless Ghidra
project across phase handoffs. Those phases may also prepare one engagement-owned fresh or forked
Anvil chain and use the pinned Foundry `v1.7.1` Forge, Cast, Anvil, and Chisel
binaries in cyberful-os. The lab provides snapshots, mutable source copies, and
synthetic account variables; candidate EVM evidence is indexed under `raw/evm/`.
Cyberful does not proxy, rewrite, or filter JSON-RPC methods: `MISSION.md` and
the program policy remain the authority for public-network activity.

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
  release paths remain in the blast radius. Native artifacts can enter the
  persistent Ghidra project here and remain available through Verify.
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
4. Project build, startup, tests, and attacks run offline inside the
   engagement-owned cyberful-os container, against loopback services only.
5. Phase-owned mutable lab trees are destroyed when their gateways close; the
   one offline tooling container is removed at engagement completion. Retained
   evidence stays under `raw/code-audit/`.

Automatic adapters cover common Node.js, Python, Go, Rust, PHP Composer, Ruby
Bundler, and Maven manifests when the matching runtime exists in cyberful-os.
Unsupported build systems or missing fixtures are reported as explicit coverage
limitations; they never cause fallback to an external deployment.

## Execution and evidence contract

Every sequential phase owns one fresh in-process Pi worker owner and private
host gateway. The owner can host a root `AgentRun`, its delegated children, and
complete fallback `AgentRun` trees. The original root alone may request the
exact successor through `handoff`. The host validates and seals the artifact,
shuts down the current owner and gateway, and only then starts the next phase.

Each sequential phase reserves its final three to five minutes for a host-owned
closeout in the same root AgentRun: children and research stop, while local
evidence, deliverable/ledger reconciliation, cleanup, and handoff remain.
Each child independently reserves that same interval before its smaller child
deadline so it can reconcile its required output artifact without changing the
root phase mode; root closeout still cancels every remaining child.
If the final deadline expires, Cyberful advances a research phase in degraded
mode only when the required partial artifact can be sealed and cleanup succeeds.
Brief never advances from a partial `MISSION.md` without explicit handoff.
Missing artifacts, invalid handoffs, failed integrity gates, and incomplete
cleanup halt the chain. Blocking human questions and complete provider retry
cycles pause the shared phase budget
timer and leave the requesting tool invocation waiting until answered,
explicitly rejected, timed out, or cancelled; no Pi process is suspended.
Authorities that differ by host, method, identity, credential, effect, risk, or
traffic bound use separate
questions, so one answer cannot authorize or reject unrelated work. Root and
child requests share this contract, and Cyberful attributes a decline to
the operator only when its human selector attests that decision.

After same-turn transient retry is exhausted, one retryable provider failure
can restart the phase automatically with a fresh owner and remaining budget.
Cyberful proves the failed gateway closed first, retains attempt-specific
diagnostics, and uses the configured fallback route when available.

Durable context lives in the workarea, transcripts, and Code Graph—not hidden
conversation state. Repository instructions, documentation, comments, web
content, and tool output are treated as untrusted evidence.

The root uses the main provider configured in `settings.yaml`. Root and
subagent runs may request a bounded fallback task, and a provider-structured
security-policy block can trigger it automatically. Fallback runs are complete:
they keep the phase's persona, tools, skills, authorization, and ability to
delegate, while their full descendant tree remains on the fallback provider.
Temporarily saturated subagent requests wait in a cancellable admission queue;
`delegation_status` exposes current capacity. The default global limit is five:
Recon admits up to three direct subagents, while Exploit and Hacker admit up to
five in both Pentest and Bug Bounty Program workflows.
Each delegation has a durable output artifact and a 30-minute default child
deadline bounded by the remaining phase budget. The configured closeout reserve
is part of that deadline rather than an extension to it.

All three workflows persist supported findings and their per-run history in
`raw/findings/registry.json`. The TUI presents that live registry in an optional
scrollable findings sidebar, using three fifths of the row for the feed and two
fifths for findings. Findings are ordered by descending severity; unverified
ratings are visibly provisional, historical entries are marked **TO BE
REVIEWED**, and disproved entries remain in a final section. `Ctrl+X`, then
`F`, `/findings`, the command palette, and the composer indicator toggle the
view.

Code Audit candidates still enter the specialized host-attested Code Graph
ledger as `suspected`. Hunt and Attack may create candidates; Verify owns
transitions to `confirmed` or `dismissed`; Report is read-only. Cyberful mirrors
that structured state into the common workarea registry and exports both SARIF
and structured evidence from the validated Code Graph ledger.

## Architecture

- `cyberful/src/` — TUI, sessions, workflow orchestration, source store,
  gateway lifecycle, Code Graph, handoffs, reporting, and cleanup.
- `cyberful/builtin/` — embedded first-party personas, budgets, instructions,
  skills, and MCP policy.
- `mcps/cyberful-os/` — unified multi-architecture image, supervisor, and
  offensive/analysis toolchain.
- `mcps/browser/` — dedicated Chromium automation.
- `mcps/zap/` — ZAP service and in-container bridge sources bundled into cyberful-os.
- `mcps/ghidra/` — native Ghidra/PyGhidra service and in-container bridge sources.

Pi Agent is the only runtime. Provider and model routing are host-owned and
configured in `settings.yaml`; OpenAI Codex, Z.AI Coding Plan, and Kimi For
Coding subscriptions are supported providers, not separate runtimes. Each phase runs under one ephemeral in-process
Pi worker owner with a private gateway, and only a validated handoff from the
original root can advance the chain.

Cyberful emits no outbound telemetry, metrics, or analytics.

## Requirements

Packaged releases require Docker and one provider configured in
`settings.yaml`. Source development additionally requires Bun 1.3.14, Node.js
24 with npm, and Python 3.10+. Keep 40 GB free to run the downloaded image and
100 GB free when building it locally. Docker Compose is not required.

See the [requirements guide](docs/getting-started/requirements.md) for the host
contract and the [fresh-host walkthrough](docs/getting-started/README.md) for
complete macOS, Linux, and Windows setup.

## Build and test

From the repository root:

```sh
make deps        # install workspace and MCP dependencies
make typecheck   # run source policy checks and TypeScript checks
make test        # run Bun/Python tests and live container contracts
make runtime-build # build the unified image for the native host architecture
make test-runtime  # exercise cyberful-os, ZAP, Ghidra, bridges, and persistence
make test-ghidra # focused native import, decompilation, annotation, and recreation
make test-all    # include loopback, ZAP, Ghidra, and Pi/provider contracts
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

Agent providers, models, delegation, fallback, and trusted instruction roots
are configured in `settings.yaml`. Cyberful creates a secret-free default file
on first launch. Reasoning effort defaults to `ultra`; older settings files gain
the explicit default automatically, and run state records both requested and
effective effort. See [Agent providers and fallback](docs/user-guide/settings.md).
Transient `unavailable` provider failures, including abnormal Codex WebSocket
closure `1006`, retry the same turn with bounded jitter while preserving
completed tool results. Retry backoff and response wait suspend active phase
time, but suspension ends before tools returned by the retry execute; each
attempt is capped at ten minutes and the entire phase shares at most 15 minutes
of default extension across root, children, fallback, retry, and recovery.
Runtime state keeps full retry wait separate from the capped compensation
applied to the deadline. Large MCP catalogs remain fully available through
per-run `tool_search` loading, and long browser pages can be read with
selector-scoped, offset-paginated snapshots instead of sending one oversized
payload. Long AgentRuns rotate their active Pi history at 75% of a configurable
operational context window and target 35% after a validated, tool-free semantic
checkpoint. Complete historical tool results remain owner-only workarea
artifacts; the original transcript and durable hypothesis/finding registries
remain authoritative. Built-in model catalog limits cannot be enlarged by
settings. GPT-5.6 Sol, GLM-5.2, and Kimi K3 default to a 256K working window,
and emergency `context_length_exceeded` recovery learns a lower session/route
bound before retrying once without executing a completed tool twice.

Provider calls are reconciled locally in
`raw/operations/provider-usage.jsonl`, split between root and delegated
AgentRuns without adding reasoning twice. The TUI shows compact `R>`/`S>`
input, cached, and generated totals plus a live count of active hypotheses.
Sanitized gateway, ZAP, browser, and MCP failures are retained as bounded,
deduplicated V2 records in `raw/operations/runtime-diagnostics.jsonl` without
placing bodies, stack traces, or details into model context. Successful tool
output never becomes a connection warning. Routine gateway `stdio` lifecycle
records and timestamp-prefixed `TRACE`/`DEBUG`/`INFO` logs remain
informational. Actionable notices distinguish recovered retries, non-blocking
tool failures, degraded observability, and terminal lifecycle failures.

Phase transcripts are appended owner-only while a phase runs. Terminal outcomes
distinguish success, warning, blocked, and failed, with structured primary
failures for provider, contract, and lifecycle errors. The TUI receives at most
12 KiB of a large tool result until its SHA-256-bound workarea artifact is
expanded, and batches live activity once per frame without reducing the result
available to the model or any tool's authority.

Normal session closure removes exact Expert container names, performs three
bounded session/run-owner Docker sweeps, and records `closed` only after a final
empty inventory. Survivors or an unavailable inventory are retained as
`closed_with_cleanup_errors` instead of being hidden by a closed session.

Workareas live under `work/<name>/`; session transcripts live under
`logs/session-logs/`. Imported repositories, authoritative snapshots, and
persistent Ghidra projects live in owner-only host stores outside the
model-writable workarea. Never place secrets directly in prompts or commit
generated workareas, transcripts, browser profiles, ZAP state, Ghidra state, or
reports.

Resume from the same launch directory:

```sh
cyberful run --continue
cyberful run --session <id>
```

While a root session is actively running, send routine guidance from another
terminal with:

```sh
cyberful --port 4096
# From another terminal:
cyberful session steer <id> --attach http://localhost:4096 --message "Recheck the active page and continue."
```

This command never starts a new turn and never answers an approval. See the
[sessions guide](docs/user-guide/sessions-and-reports.md#steer-an-active-session-from-another-terminal)
for remote routing, authentication, and CAPTCHA handoffs.

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

Cyberful is released under the [GNU Affero General Public License v3.0 only](LICENSE)
(`AGPL-3.0-only`). Use it only on systems and source you are authorized to assess.
You are responsible for scope, authorization, legal compliance, and safe operation.
