# Cyberful

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
npm install --global @cyberful/cli
cyberful auth login
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
routing; failed profiles remain behind an **OK, retry** question and prevent a
final `MISSION.md`. It records passively observed application dependencies for
downstream reasoning without treating them as direct testing targets or blocking Recon. Recon maps the target,
separates concrete anomalies and target-specific seams from retained coverage ideas, and records probability,
impact, positive evidence, contrary evidence, and discriminating tests independently. Exploit performs
systematic, reproducible validation. Hacker investigates unconventional chains and
assumptions. Verify independently retests claims. Report produces the
client-facing PDF.

The workflow can use cyberful-os, the isolated browser, headless OWASP ZAP, and
a persistent headless Ghidra project during Recon through Verify.
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
target-specific unknown-unknown exploration. A host-owned novelty ledger counts
semantic root-cause families rather than endpoint variations, detects local
convergence, and requires a final contrarian synthesis. Exploit and Hacker also
hand off a structured verdict inventory that distinguishes positive-evidence
`SUSPECTED`, tested-but-ambiguous `INCONCLUSIVE`, and never-ran `UNTESTABLE`.

The Bug Bounty ceilings are deliberately long: 30 minutes for Brief, 240 for
Recon, 360 each for Exploit and Hacker, 180 for Verify, and 90 for Report.
Novelty remains qualitative: convergence triggers a contrarian pivot, not a
quota, while browser surface coverage steers the phases toward unvisited real
journeys without making click or route counts into handoff gates.

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
4. Project build, startup, tests, and attacks run offline inside the phase-owned
   cyberful-os container, against loopback services only.
5. The phase container and mutable lab tree are destroyed at phase exit;
   retained evidence stays under `raw/code-audit/`.

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

If a phase exhausts its active-execution budget, Cyberful advances in degraded mode
only when the required partial artifact can be sealed and cleanup succeeds.
Missing artifacts, invalid handoffs, failed integrity gates, and incomplete
cleanup halt the chain. Blocking human questions pause every AgentRun budget
timer and leave the requesting tool invocation waiting until answered,
explicitly rejected, timed out, or cancelled; no Pi process is suspended.
Authorities that differ by host, method, identity, credential, effect, risk, or
traffic bound use separate
questions, so one answer cannot authorize or reject unrelated work. Root and
child requests share this contract, and Cyberful attributes a decline to
the operator only when its human selector attests that decision.

Durable context lives in the workarea, transcripts, and Code Graph—not hidden
conversation state. Repository instructions, documentation, comments, web
content, and tool output are treated as untrusted evidence.

The root uses the primary provider configured in `settings.yaml`. Root and
subagent runs may request a bounded fallback task, and a provider-structured
security-policy block can trigger it automatically. Fallback runs are complete:
they keep the phase's persona, tools, skills, authorization, and ability to
delegate, while their full descendant tree remains on the fallback provider.

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
- `mcps/cyberful-os/` — isolated offensive and analysis toolchain.
- `mcps/browser/` — dedicated Chromium automation.
- `mcps/zap/` — headless OWASP ZAP runtime and bridge for live-target workflows.
- `mcps/ghidra/` — persistent headless PyGhidra runtime and disposable phase bridge.

Pi Agent is the only runtime. Provider and model routing are host-owned and
configured in `settings.yaml`; an OpenAI Codex OAuth account is one supported
provider, not a separate runtime. Each phase runs under one ephemeral in-process
Pi worker owner with a private gateway, and only a validated handoff from the
original root can advance the chain.

Cyberful emits no outbound telemetry, metrics, or analytics.

## Requirements

- Bun 1.3.14 or compatible for source builds
- one provider configured in `settings.yaml` and its required credentials
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
make test-ghidra # real binary import, decompilation, call graph, annotation, and restart
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
on first launch. See [Agent providers and fallback](docs/user-guide/settings.md).

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
