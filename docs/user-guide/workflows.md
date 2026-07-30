# Choose a security workflow

Cyberful has three security workflows. Choose by the subject and delivery format you need:

| Workflow               | Subject                                                                                       | Traffic policy                              | Primary result                                               |
| ---------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| **Pentest**            | An authorized running target                                                                  | Only the recorded mission                   | `reports/security-report.pdf`                                |
| **Bug Bounty Program** | An authorized running target under a supplied bounty policy                                   | Only the recorded mission and program rules | `BUG_BOUNTY_REPORT.md` plus per-finding Markdown submissions |
| **Code Audit**         | Repository, explicit Git diff, architecture, dependencies, build, controls, and local runtime | External target traffic disabled            | `reports/code-audit-report.pdf`                              |

Use `/workflow` or `/workflows` on the welcome screen to select one. `Tab`
cycles the same choices before the session begins. The selection is fixed once
the session starts.

After completion, Cyberful opens **Ask** for follow-up questions against the
existing workarea. Ask can explain findings and evidence but cannot broaden the
recorded scope.

## Phase isolation

Each phase runs under a fresh in-process Pi worker owner behind a private host
gateway. Its original root `AgentRun` must write the required artifact and call
`handoff` with the exact successor. The gateway rejects handoff while the exact
required artifact is absent, empty, a symlink, or outside the workarea root, so
the same AgentRun can repair the deliverable before stopping. The host rechecks
and seals the artifact, shuts down the owner and gateway, and only then starts
the next phase. Delegated and fallback runs can perform complete operational
tasks but cannot advance the phase.

An active-execution budget applies to active work. The final three to five
minutes are a host-enforced closeout: the same root stops researching, children
are cancelled, research tools are blocked, and only local evidence,
deliverable/ledger reconciliation, cleanup, and handoff remain. If the final
deadline expires, Cyberful advances a research phase in degraded mode only when
the partial artifact exists, can be sealed, and every phase-owned process has
stopped. Brief never advances from a partial `MISSION.md` without an explicit
handoff. Invalid handoffs, missing artifacts, failed integrity gates, and
incomplete cleanup halt the chain.

Blocking questions and complete provider-retry cycles pause the shared phase
budget clock and leave the requesting tool call waiting; they do not suspend a
Pi process. Retry suspension ends when the provider response arrives, before
executing any returned tools. The workarea,
sealed artifacts, Code Graph, and evidence are the durable memory; model
conversation state does not cross phase boundaries.

Within one long AgentRun, deterministic context projection preserves complete
tool evidence as local artifacts. If that is insufficient, the same model can
write a validated semantic checkpoint containing structured continuity plus
free-form working notes. This changes only the next provider payload: it never
deletes the audit transcript or supersedes the hypothesis and finding
registries.

Root, subagent, and fallback actors are all complete Pi `AgentRun` instances
with the same phase authority, tools, skills, and evidence contract. Provider
fallback is host-routed and bounded; see
[Agent providers and fallback](settings.md).

Live-target phases also keep an append-only lifecycle ledger for synthetic
target objects. The model records intent before creation and ends each object as
`not_created`, `cleaned`, or `residual`; only a forgotten intermediate state
blocks handoff. A residual object is visible but is not itself an approval gate.

At terminal session closure, Cyberful removes the exact Expert container names
and rechecks Docker by immutable session and run-owner labels in three bounded
passes. `raw/operations/run-state.json` records `closed` only after the final
inventory proves absence; survivors or an unavailable inventory produce
`closed_with_cleanup_errors` and a lifecycle failure.

The host derives phase handoff verdicts from the canonical
`raw/hypotheses/registry.json`. Each hypothesis has one mutually exclusive state:
`OPEN`, `TESTING`, `QUEUED`, `CONFIRMED`, `DISPROVED`, `SUSPECTED`,
`INCONCLUSIVE`, or `UNTESTABLE`.
`SUSPECTED` requires affirmative target evidence. `INCONCLUSIVE` means a valid
test ran but its oracle remained ambiguous. `UNTESTABLE` means the discriminating
test never ran and therefore records a typed blocker plus an exact next step.
This prevents missing access, tools, applicability, authority, or budget from
inflating the suspected-finding count.

`CONFIRMED` and `SUSPECTED` entries must link current-run findings. Negative-only
outcomes can retain stable backlog IDs when they never met the positive-evidence
threshold for entering the finding registry.

Before using `UNTESTABLE` for a credible, high-value path, Exploit and Hacker
actively seek safe prerequisites in existing evidence, ordinary product flows,
and authoritative first-party material. They create reversible tester-owned
state within existing authority and use authenticated profiles plus saved
session-variable access to complete ordinary login flows autonomously. They ask
one exact blocking question only when a concrete human fact, human-only
authentication action, decision, or additional authority unlocks the
discriminator.

Exploit and Hacker subagents inherit the phase's complete execution authority
and retain ownership of each task through its verdict. They may start passively,
but run safe in-scope discriminators themselves; task partitioning and shared-
resource contention are not `UNTESTABLE` blockers.

## Pentest

```text
brief → recon → exploit → hacker → verify → report
```

Pentest tests a live target within an explicit authorization boundary.

| Phase       | Responsibility                                                                                                                               | Required artifact |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **Brief**   | Fix targets, exclusions, identities, access, rules, and traffic limits; preflight supplied browser accounts and record observed dependencies | `MISSION.md`      |
| **Recon**   | Map the surface; calibrate anomalies, hypotheses, applicability, and retained coverage ideas                                                 | `RECON.md`        |
| **Exploit** | Systematically reproduce candidates with bounded PoCs and controls                                                                           | `EXPLOIT.md`      |
| **Hacker**  | Investigate unconventional assumptions, chains, and adjacent hypotheses                                                                      | `HACKER.md`       |
| **Verify**  | Independently retest every material claim                                                                                                    | `VERIFY.md`       |
| **Report**  | Produce the client-facing security report                                                                                                    | `REPORT.md`       |

Pentest can use cyberful-os, isolated Chromium, headless OWASP ZAP, and the
persistent headless Ghidra project from Recon through Verify. Ghidra imports,
analysis, call graphs, names, and annotations survive phase and runtime
replacement; portable results are indexed under `raw/ghidra/`. See the
[Ghidra runtime](../runtimes/ghidra.md). Bounded
tests using tester-owned or uniquely marked synthetic state inside the mission
run autonomously. Cleanup is attempted when the target exposes a supported
mechanism; the absence of cleanup for one residual synthetic record does not by
itself require a human decision. Persistent code or retained reusable access,
value-moving, disruptive, cross-scope, or uncontrolled-user actions still do.
Tool availability never expands the mission.

For explicitly supplied browser accounts, Brief also completes the normal login
autonomously when stored access is sufficient. Browser inputs reference session
variables as `{{var:name}}`; the host resolves their values after the model
boundary and redacts them from returned evidence. Brief asks the operator only
when a human-only challenge, missing second factor, rejected or locked access,
unavailable profile, or degraded proxy prevents readiness.

Brief creates a useful initial `MISSION.md` before navigation, then atomically
replaces that same file after policy acquisition, every account/profile check,
engagement-policy installation, and each material ambiguity resolution. Each
hash change creates a semantic checkpoint. Its tool surface is preflight-only:
policy/source reads and approved imports, session variables, engagement policy,
ordinary browser login/snapshot actions and passive network log, local
attachment/mission operations, hypotheses, and handoff. ZAP API/history/replay,
direct request tools, scanners, labs, Ghidra, page evaluation, cookie access,
and response-body extraction are not published in Brief; the browser still
uses ZAP as its host-owned proxy.

The terminal result is `reports/security-report.pdf`.

`RECON.md` does not equate a sensitive feature or familiar architecture pattern with a vulnerability. Each
active candidate records probability separately from impact, positive and contrary evidence, missing
evidence, and one discriminating test with secure and vulnerable oracles. Target-relevant ideas that lack a
concrete signal remain visible in a deduplicated coverage backlog instead of being discarded or presented as
equally likely suspected failures. Exploit inherits this calibration and must reconcile the backlog explicitly.

## Bug Bounty Program

```text
brief → recon → exploit → hacker → verify → report
```

Bug Bounty Program tests a live target under both an explicit authorization
boundary and the supplied program policy.

| Phase       | Responsibility                                                                      | Required artifact      |
| ----------- | ----------------------------------------------------------------------------------- | ---------------------- |
| **Brief**   | Record program provenance, exact policy, supplied access, and binding restrictions  | `MISSION.md`           |
| **Recon**   | Run the shared calibrated Pentest surface mapping, including authenticated journeys | `RECON.md`             |
| **Exploit** | Run the shared Pentest systematic validation policy                                 | `EXPLOIT.md`           |
| **Hacker**  | Run the shared Pentest unconventional attack policy                                 | `HACKER.md`            |
| **Verify**  | Independently retest and classify technical verdict plus submission readiness       | `BUG_BOUNTY_VERIFY.md` |
| **Report**  | Create one portable Markdown submission per ready finding and a navigation index    | `BUG_BOUNTY_REPORT.md` |

Supply the official policy as text, an attachment, or an exact public URL. Brief
may read that page and performs the same bounded readiness preflight as Pentest
for explicitly supplied profiles: ZAP routing, one normal authenticated entry,
autonomous login from stored access when required, distinct visible identities,
and passive dependency mapping. `MISSION.md`
contains a prerequisite matrix whose readiness is `READY` or `BLOCKED` and
whose scope is `IN_SCOPE`, `OUT_OF_SCOPE`, or action-specific `UNRESOLVED`.
Broken promised access blocks Recon; one unresolved action does not block
independent in-scope research.

Bug Bounty uses longer active-execution ceilings suited to sustained research: Brief
30 minutes, Recon 240, Exploit 360, Hacker 360, Verify 180, and Report 90.
Every Bug Bounty phase reserves the final five minutes for closeout. Pentest
reserves three minutes in Brief and five in every later phase; every Code Audit
phase reserves five.
Recon, Exploit, and Hacker receive a qualitative novelty contract through the
shared `hypothesis` registry. Its synthesis
treats endpoint, payload-spelling, or version variations of one mechanism as
convergence and emits one runtime signal when the search narrows. Each phase
then performs a contrarian pivot and writes a synthesis of semantically distinct
avenues, or explains with target-specific evidence why further diversification
is exhausted. There are no numeric quotas or minimum route, click, hypothesis,
or family counts that block handoff.

Recon prioritizes real authenticated journeys and broad route/action coverage.
Redacted browser metadata produces an append-only surface map; Exploit and
Hacker consume its unexplored and failed areas when choosing pivots. Additional
routes of the same mechanism improve coverage but do not count as new causal
creativity.

The matrix is a readiness and authorization floor, never a finite test list.
New surfaces and target-specific hypotheses discovered by Recon, Exploit, or
Hacker are added dynamically to the hypothesis registry and tested when
authorized. `UNRESOLVED` is valid only for one exact action and asset after the
phase records authoritative sources, the missing or contradictory rule, and a
real resolution attempt. The next research phase revisits it before using scope
ambiguity as a blocker.

Brief also writes `raw/policy/engagement.json`, a non-secret projection of
profile readiness, authorized HTTP hosts, and the aggregate HTTP RPS limit.
Each fresh ZAP runtime installs one shared Network rule before traffic. If a
numeric limit exists, ZAP startup and browser proxying fail closed.
The gateway commits this file only after the Brief's current ZAP runtime accepts
the policy, and Brief handoff is refused until that succeeds in the current
phase. A host-side installation failure is reported once as a non-retryable
technical blocker; it is not turned into a generic approval or a request to
restore ZAP.

Code Audit uses the same hypothesis lifecycle from Scope onward without
enabling target traffic. Scope and Index persist architectural questions before
handoff; Trace links Code Graph paths, Hunt promotes only positively supported
candidates to `code_finding`, Attack updates them from lab evidence, and Verify
reconciles finding and hypothesis dispositions. Code Graph and the finding
registry remain their respective authorities.

### Smart-contract source and EVM lab

Brief and Recon may use `source_import` for up to eight approved public HTTPS
repositories. Each stable alias records an exact root commit, ref mapping,
content fingerprint, and recursive submodules at their Gitlink commits. After
Recon the collection is immutable; later phases can inventory, read, search,
snapshot, and materialize selected repositories without modifying the
host-owned imports. Existing Code Audit manifest v2 imports remain readable.

Recon, Exploit, Hacker, and Verify may use `evm_lab` to prepare one managed
Anvil chain in `fresh` or `fork` mode. Forks can pin a block and resolve
`{{var:name}}` RPC URLs. The tool returns a host/browser loopback endpoint and a
`host.docker.internal` endpoint for Forge or Cast in cyberful-os, synthetic
account addresses plus redacted session-variable names, an automatic baseline
snapshot, and named snapshot/revert operations. The node survives phase changes
and is destroyed with its variables and compiler cache on engagement exit.

The managed path is optional convenience. Forge, Cast, the shell, and additional
Anvil nodes remain directly usable. Cyberful adds no RPC proxy, method filter,
or rewriting layer; the mission and supplied program rules govern direct public
RPC access. `evm_evidence` hashes an existing candidate-finding artifact into
`raw/evm/evidence.json` with its command, source commit, toolchain, lab, fork,
seed/runs, and local transaction provenance. Generic stdout and routine Cast
calls are not archived automatically. See [EVM runtime](../runtimes/evm.md).

Verify assigns stable `BBP-###` IDs and one of `SUBMISSION_READY`,
`NEEDS_MORE_EVIDENCE`, or `NOT_REPORTABLE`. Report emits only ready findings:

```text
BUG_BOUNTY_REPORT.md
reports/bug-bounty/BBP-001.md
reports/bug-bounty/BBP-002.md
```

The index is always produced, including when no finding is ready. Cyberful does
not call HackerOne, Bugcrowd, or another program API and never submits reports
automatically.

## Code Audit

```text
scope → index → trace → hunt → attack → verify → report
```

Code Audit examines the implemented security model across source,
architecture, identities, dataflows, controls, dependencies, build and release
authority, deployment, and a disposable local runtime. It never edits the
user's checkout.

| Phase      | Responsibility                                                                                        | Required artifact      |
| ---------- | ----------------------------------------------------------------------------------------------------- | ---------------------- |
| **Scope**  | Fix snapshot and audit lens; inventory architecture, threats, trust, dependency and release authority | `CODE_SCOPE.md`        |
| **Index**  | Build and quality-check the full semantic Code Graph                                                  | `CODE_GRAPH.md`        |
| **Trace**  | Map sources, sinks, guards, control ownership, negative tests, and producer-to-runtime paths          | `CODE_TRACE.md`        |
| **Hunt**   | Create a complete suspected-candidate and variant ledger                                              | `CODE_HUNT.md`         |
| **Attack** | Build and attack a disposable local lab; retain controlled runtime evidence                           | `CODE_ATTACK.md`       |
| **Verify** | Independently refute or confirm every candidate in a fresh context and lab                            | `CODE_VERIFY.md`       |
| **Report** | Synthesize verified risk, coverage, limitations, remediation, and structured exports                  | `CODE_AUDIT_REPORT.md` |

Index through Verify can use the same persistent Ghidra project for native
artifacts. Scope and Report receive only the captured `raw/ghidra/` evidence,
not the live mutation surface.

Terminal outputs are:

```text
reports/code-audit-report.pdf
CODE_AUDIT_REPORT.md
reports/code-audit.sarif
reports/code-audit-evidence.json
```

### Audit lenses

Code Audit defaults to a full-repository audit. It switches to a diff lens only
when the objective explicitly requests a branch, commit range, pull-request
equivalent, or current local changes.

For a diff audit, Scope calls the host-owned `audit_diff_prepare` tool. It uses
only local Git objects and combines the requested commit range with staged,
unstaged, and untracked files when appropriate. It records:

- base, head, merge base, and current branch;
- changed and untracked paths;
- working-tree status;
- patch byte length and SHA-256;
- `raw/code-audit/diff/changes.patch` and
  `raw/code-audit/diff/manifest.json`.

The Git child process disables transports, credentials, prompts, hooks,
submodules, lazy promisor fetch, automatic maintenance, external diff and text
conversion, and repository-declared clean/smudge/process filters. The user's
checkout is read-only.

A diff limits the primary review surface, not the reasoning context. Index
still builds the full graph, and later phases include callers, callees, guards,
schemas, tests, configuration, deployments, dependencies, CI, and release
authority in the blast radius.

### Source import and trust

Scope may request one credential-free public Git URL over HTTPS. Before the
network call, the TUI presents the fixed hostname for explicit approval. The
importer blocks credentials, redirects, hooks, Git LFS, non-HTTPS transports,
private/local destinations, and dependency installation. When recursive
submodules are selected, it resolves only credential-free HTTPS URLs and
materializes each exact Gitlink commit. It seals the root and submodule commits,
content fingerprints, and local ref mapping, including the history needed for
local merge-base analysis.

The authoritative import or source snapshot lives in an owner-only host store
outside the model-writable workarea. Phases use bounded read-only source tools
and virtual source identities. Repository `AGENTS.md`, `CLAUDE.md`, skills,
prompts, comments, documentation, and generated output remain untrusted audit
evidence.

Inventories retain `vendor/` and `.vscode/` because sandbox code, executable
tasks, workspace settings, and extension policy can be security-relevant.
Dependency caches, VCS metadata, and ordinary build output are bounded
exclusions and appear in coverage metadata.

### Code Graph readiness

Index cannot hand off to Trace using narrative output alone. After the Index
gateway stops, the host revalidates source authority and compares the current
full-inventory graph snapshot and per-file coverage with a signed readiness
record. Partial indexing, stale or tampered coverage, source drift, or missing
attestation blocks Trace.

The graph is a coverage and hypothesis engine, not proof. Every adapter reports
its actual parsing, symbol, control-flow, call-graph, dataflow, aliasing,
summary, security-semantics, and cross-language capability. Query truncation,
unresolved edges, unsupported languages, and declarative-only semantics remain
visible through Report.

### Finding ownership

The gateway enforces a small finding lifecycle:

```text
Hunt or Attack: suspected → Verify: confirmed | dismissed → Report: read-only
```

Every finding has stable identity, locations, traces, evidence, weakness,
severity, confidence, and remediation guidance. Repeated scanner output cannot
promote a candidate. Report exports SARIF and evidence JSON from the validated,
host-attested ledger rather than model-authored structured files.

### Disposable runtime lab

Attack and Verify each receive a separate lab. `audit_lab_prepare` attempts it
automatically when the project can run locally.

Dependency bootstrap and project execution are intentionally split:

1. The host copies recognized manifests and lockfiles only.
2. A networked bootstrap container receives that directory, no project source,
   no host credentials, no Docker socket, no elevated capabilities, and fixed
   CPU, memory, and PID limits.
3. Package-manager lifecycle scripts and audit/telemetry paths are disabled
   where supported. The bootstrap container is destroyed.
4. The host materializes the sealed source into the resulting lab tree.
5. The phase-owned cyberful-os container runs offline and uses loopback for the
   project and attack tools.
6. The gateway removes the mutable lab tree at phase exit. Durable, redacted
   evidence remains under `raw/code-audit/attack/`,
   `raw/code-audit/verify/`, and their lab records.

Recognized adapters cover common npm, pnpm, Yarn, Bun, pip, uv, Poetry, Go,
Cargo, Composer, Bundler, and Maven inputs when the toolchain exists in the
bundled image. Missing services, fixtures, secrets, architecture, or adapter
support become explicit limitations. Code Audit never attacks an external
deployment as a substitute.
