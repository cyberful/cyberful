# Application security workflows

Cyberful provides five sequential workflows for different application-security
jobs. Choose the workflow by the decision you need to make—not by the tools you
expect it to run. Each workflow owns its scope, evidence rules, network policy,
phase sequence, and terminal outputs.

## Choose a workflow

From the welcome screen, enter `/workflows` to open the workflow selector. The
short `/workflow` alias opens the same selector, and `Tab` cycles through the
available workflows before the first session starts. The selected workflow is
then fixed for that session.

| Workflow          | Use it when you need to                                                                        | Source boundary                                                | Target traffic                                     | Primary result                    |
| ----------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- | --------------------------------- |
| **Pentest**       | Test an authorized live target as an attacker                                                  | Engagement scope and supplied artifacts                        | Allowed only by the recorded mission               | `reports/security-report.pdf`     |
| **Code Audit**    | Find and verify vulnerabilities across a source tree                                           | Local source, copied source, or one approved public Git import | Never                                              | `reports/code-audit-report.pdf`   |
| **Assessment**    | Evaluate code, architecture, controls, supply chain, infrastructure, and runtime risk together | Local source, copied source, or one approved public Git import | Only through explicit, origin-scoped authorization | `reports/security-assessment.pdf` |
| **Remediate**     | Reproduce selected findings, implement minimal fixes, and prove the regression is closed       | Git repository plus an isolated writable worktree              | Only through explicit, origin-scoped authorization | `REMEDIATION_REPORT.md`           |
| **Secure Review** | Review a local Git change and its graph-derived blast radius                                   | Local Git objects and working-tree changes                     | Never                                              | `SECURE_REVIEW.md`                |

Use **Code Audit** for repository-wide vulnerability research and **Secure
Review** for a bounded change. Use **Assessment** when the answer must combine
technical findings with architecture, supply-chain, infrastructure, or
control-readiness evidence. Use **Remediate** only when the required outcome is
a verified code change. Use **Pentest** when the primary subject is an
authorized running target rather than a source repository.

Code Audit and Assessment can analyze a directory that is not a Git repository.
Secure Review and Remediate require a repository with a valid `HEAD`, because
their boundaries depend on merge-base, commit, and worktree semantics.

## One phase owns the runtime

Every workflow is a fixed sequence of phases. A phase runs in a fresh Codex
app-server process behind its own private host gateway. It must write the
required artifact and request a valid handoff. The host validates both, stops
the current process and gateway, and only then starts the successor.

If the phase reaches its wall-clock budget before requesting the handoff, the
host advances in degraded mode only when the required partial artifact exists,
can be sealed, and the old process and gateway have fully stopped. The host
then creates the configured handoff for the successor. Invalid handoffs,
missing artifacts, seal failures, and incomplete cleanup remain blocking.

After a phase exits, Cyberful normalizes typographic confusables only in that
phase's declared Markdown deliverable. It does not recursively sanitize the
workarea, imported source, snapshots, earlier artifacts, or repository
documentation.

This keeps phases sequential and prevents hidden model memory from becoming
workflow state. Durable context lives in workarea artifacts and the local Code
Graph. When a workflow completes, Cyberful opens **Ask** for follow-up questions
against the same recorded workarea; Ask cannot broaden its scope.

## Pentest

```text
brief → recon → exploit → hacker → verify → report
```

Pentest is the live-target workflow. Its mission records the authorized target,
rules of engagement, and traffic policy before later phases investigate or
interact with the target. Exploit owns systematic validation end to end: it can
write and run PoCs, operate short-lived test infrastructure, and turn behavior
observed during both successful and failed attempts into new hypotheses. It
must also close source provenance for promising sinks by exhausting safe
first-party paths before recording an unavailable fixture or out-of-scope
system as the exact blocker. It hands Hacker a cleaned evidence base with only
genuine blockers; Hacker spends its phase on unconventional assumptions and
novel chains rather than unfinished routine checks, applying the same
source-provenance rule to newly discovered primitives. Both phases judge risk
from the concrete action rather than the potential severity: bounded reversible
tests and temporary fixtures on tester-controlled accounts run autonomously,
while irreversible, value-moving, disruptive, cross-scope, or uncontrolled-user
actions wait for the human. Verification is
independent from both offensive phases, and the report phase produces the
client-facing security report.

Required phase artifacts are `MISSION.md`, `RECON.md`, `EXPLOIT.md`,
`HACKER.md`, `VERIFY.md`, and `REPORT.md`. The terminal result is
`reports/security-report.pdf`.

## Code Audit

```text
scope → index → trace → hunt → verify → report
```

Code Audit performs repository-wide, graph-assisted static analysis. It maps
the accepted source, records analysis coverage, traces security-relevant flows,
hunts for vulnerabilities and related variants, and independently verifies
candidates before reporting them. It may compile or test the fixed snapshot
when useful, but it cannot browse or scan a target.

Required phase artifacts are `CODE_SCOPE.md`, `CODE_GRAPH.md`,
`CODE_TRACE.md`, `CODE_HUNT.md`, `CODE_VERIFY.md`, and
`CODE_AUDIT_REPORT.md`. Terminal outputs are the PDF report, the Markdown
source, and `reports/code-audit.sarif`.

Index cannot hand off to Trace on narrative output alone. The host re-runs the
source preflight after the gateway stops and requires a signed readiness record
for a repository-wide graph index. Its graph snapshot identifier, fingerprint,
and complete per-file coverage digest must still match the SQLite state. A
missing import attestation, partial-only index, absent graph snapshot, stale or
tampered coverage, or live gateway blocks Trace even when `CODE_GRAPH.md` and a
syntactically valid handoff exist.

## Assessment

```text
brief → map → controls → test → correlate → verify → report
```

Assessment combines code and architecture analysis with supply-chain,
infrastructure, control-readiness, and—when explicitly authorized—runtime
evidence. Runtime access is not implied by choosing the workflow. The brief
phase must request authorization for exact HTTP(S) or WS(S) origins; only the
test phase receives the resulting browser and ZAP routes and their bounded call
budget.

Required phase artifacts are `ASSESSMENT_MISSION.md`, `ASSESSMENT_MAP.md`,
`ASSESSMENT_CONTROLS.md`, `ASSESSMENT_TEST.md`, `ASSESSMENT_RISK.md`,
`ASSESSMENT_VERIFY.md`, and `ASSESSMENT_REPORT.md`. Terminal outputs are the
PDF report, the Markdown source, and `reports/assessment-evidence.json`.
Control-framework mappings are audit-readiness evidence, not certification or
attestation.

## Remediate

```text
intake → plan → implement → verify → publish
```

Remediate accepts verified Cyberful finding IDs or findings supplied by the
user. Intake must reproduce each selected issue before any source change is
authorized. Cyberful then creates an isolated writable worktree; the original
checkout is never edited. Verification binds pre-fix and post-fix evidence to
the selected findings and the exact Git delta.

Required phase artifacts are `REMEDIATION_SCOPE.md`, `REMEDIATION_PLAN.md`,
`REMEDIATION_CHANGES.md`, `REMEDIATION_VERIFY.md`, and
`REMEDIATION_REPORT.md`. Terminal side artifacts are
`reports/remediation.patch` and `reports/remediation-publish.json`.

Publication is a separate boundary. Cyberful presents the branch, commit,
findings, and test proof for an explicit human decision. If approved, it pushes
the branch and may create a draft pull or merge request. Declining publication
keeps the local branch and commit.

## Secure Review

```text
map → audit → verify
```

Secure Review analyzes the local merge-base diff and its graph-derived blast
radius. It combines committed branch changes with staged, unstaged, and
untracked files. Base and head revisions must already exist in the local object
database: the workflow does not fetch missing objects or consult forge APIs.

Cyberful excludes its exact workarea and session-log roots from review
inventories and records those exclusions in the review manifest. If either root
is tracked by the repository, preparation fails closed rather than silently
hiding project content. An empty source delta remains an explicit empty review;
Cyberful does not turn its own transcripts or graph database into findings.

Required phase artifacts are `REVIEW_MAP.md`, `REVIEW_FINDINGS.md`, and
`SECURE_REVIEW.md`. The final phase also produces
`reports/secure-review.sarif` from the validated finding ledger.

## Public source import

The initial source-defining phase may request one credential-free public Git
URL over HTTPS: Code Audit `scope`, Assessment `brief`, Remediate `intake`, or
Secure Review `map`. Before network access, the TUI presents the fixed hostname
for explicit human approval. The import records the resolved addresses, exact
commit, and local ref mapping.

The importer blocks credentials, redirects, hooks, submodules, Git LFS
downloads, non-HTTPS transports, dependency installation, and private or local
network destinations. Once import completes, all source analysis is local.
Permission to import public source does not authorize traffic to a deployed
target.

The authoritative repository and deterministic source snapshot live in an
owner-only host source store outside the model-writable workarea. Phases receive
bounded read-only source tools and virtual `source://` identities, not a native
writable path. The import manifest uses a durable key scoped to that canonical
workarea/import; it survives session resumption and is separate from the
session-scoped Code Graph finding ledger. Mutable `raw/source-import` or
`raw/source-snapshot` workarea copies are not accepted as source authority.

Inventories and Code Graph indexing retain `vendor/` and `.vscode/`. Generated
dependencies, caches, VCS metadata, and build output remain bounded exclusions
and are reported in snapshot/coverage metadata rather than being confused with
an examined file set.

All repository text is untrusted evidence. Files such as `AGENTS.md`,
`CLAUDE.md`, `.codex/**`, `.agents/**`, repository skills, prompts, comments,
and documentation cannot issue operational instructions to an audit phase.
Only Cyberful's active host policy and embedded first-party persona/skills are
instruction authorities.

## Offline Git boundary

Before publication, repository workflows disable lazy promisor fetches, Git
transports, credentials, prompts, hooks, submodule recursion, automatic
maintenance, repository-declared clean/smudge/process filters, external diffs,
and text conversion. Proxy and injected Git configuration are removed from the
child-process environment. A missing partial-clone object therefore becomes an
explicit coverage failure instead of an implicit fetch.

Only an explicitly approved Remediate push enters the dedicated publication
path and may use the host's non-interactive network credentials. That consent
authorizes the declared push; it does not authorize a fetch or broader network
activity.

## Shared Code Graph and finding ledger

Code Audit, Assessment, Remediate, and Secure Review share Cyberful's local,
incremental Code Graph. It inventories accepted source, relates files, symbols,
flows, dependencies, endpoints, resources, and trust boundaries, and supports
bounded path, taint, slice, neighborhood, symbol, and coverage queries.

The graph is a search and coverage aid, not semantic proof. Each result exposes
its confidence, capability level, limits, and truncation. Findings enter a
host-validated ledger and must be independently verified before terminal SARIF
or assessment evidence is generated.
