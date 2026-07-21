# Choose a security workflow

Cyberful has three security workflows. Choose by the subject and delivery format you need:

| Workflow | Subject | Traffic policy | Primary result |
| --- | --- | --- | --- |
| **Pentest** | An authorized running target | Only the recorded mission | `reports/security-report.pdf` |
| **Bug Bounty Program** | An authorized running target under a supplied bounty policy | Only the recorded mission and program rules | `BUG_BOUNTY_REPORT.md` plus per-finding Markdown submissions |
| **Code Audit** | Repository, explicit Git diff, architecture, dependencies, build, controls, and local runtime | External target traffic disabled | `reports/code-audit-report.pdf` |

Use `/workflow` or `/workflows` on the welcome screen to select one. `Tab`
cycles the same choices before the session begins. The selection is fixed once
the session starts.

After completion, Cyberful opens **Ask** for follow-up questions against the
existing workarea. Ask can explain findings and evidence but cannot broaden the
recorded scope.

## Phase isolation

Each phase runs in a fresh Codex app-server process behind a private host
gateway. It must write its required artifact and call `handoff` with the exact
successor. The host validates and seals the artifact, stops the process and
gateway, and only then starts the next phase.

A wall-clock budget applies to active work. If it expires, Cyberful advances in
degraded mode only when the required partial artifact exists, can be sealed,
and every phase-owned process has stopped. Invalid handoffs, missing artifacts,
failed integrity gates, and incomplete cleanup halt the chain.

Blocking questions pause both the process group and active-time budget. The
workarea, sealed artifacts, Code Graph, and evidence are the durable memory;
model conversation state does not cross phase boundaries.

## Pentest

```text
brief → recon → exploit → hacker → verify → report
```

Pentest tests a live target within an explicit authorization boundary.

| Phase | Responsibility | Required artifact |
| --- | --- | --- |
| **Brief** | Fix targets, exclusions, identities, access, rules, and traffic limits; preflight supplied browser accounts and record observed dependencies | `MISSION.md` |
| **Recon** | Map the authorized surface and produce testable leads | `RECON.md` |
| **Exploit** | Systematically reproduce candidates with bounded PoCs and controls | `EXPLOIT.md` |
| **Hacker** | Investigate unconventional assumptions, chains, and adjacent hypotheses | `HACKER.md` |
| **Verify** | Independently retest every material claim | `VERIFY.md` |
| **Report** | Produce the client-facing security report | `REPORT.md` |

Pentest can use cyberful-os, isolated Chromium, and headless OWASP ZAP. Bounded,
reversible tests inside the mission run autonomously. Irreversible,
value-moving, disruptive, cross-scope, or uncontrolled-user actions require a
human decision. Tool availability never expands the mission.

The terminal result is `reports/security-report.pdf`.

## Bug Bounty Program

```text
brief → recon → exploit → hacker → verify → report
```

Bug Bounty Program tests a live target under both an explicit authorization
boundary and the supplied program policy.

| Phase | Responsibility | Required artifact |
| --- | --- | --- |
| **Brief** | Record program provenance and exact policy; preflight supplied browser accounts and ZAP routing, then record observed dependencies | `MISSION.md` |
| **Recon** | Run the shared Pentest surface-mapping policy | `RECON.md` |
| **Exploit** | Run the shared Pentest systematic validation policy | `EXPLOIT.md` |
| **Hacker** | Run the shared Pentest unconventional attack policy | `HACKER.md` |
| **Verify** | Independently retest and classify technical verdict plus submission readiness | `BUG_BOUNTY_VERIFY.md` |
| **Report** | Create one portable Markdown submission per ready finding and a navigation index | `BUG_BOUNTY_REPORT.md` |

Supply the official policy as text, an attachment, or an exact public URL. Brief
may read an explicitly supplied public policy page and, when existing accounts
were declared, make one normal target visit per profile for readiness only. It
requires the target session, distinct account identity where promised, and ZAP
routing before Recon. A failed profile opens an **OK, retry** question and stays
blocked without a final `MISSION.md` until the repaired state passes. This
preflight does not run payloads, replay requests, or test a vulnerability.


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

| Phase | Responsibility | Required artifact |
| --- | --- | --- |
| **Scope** | Fix snapshot and audit lens; inventory architecture, threats, trust, dependency and release authority | `CODE_SCOPE.md` |
| **Index** | Build and quality-check the full semantic Code Graph | `CODE_GRAPH.md` |
| **Trace** | Map sources, sinks, guards, control ownership, negative tests, and producer-to-runtime paths | `CODE_TRACE.md` |
| **Hunt** | Create a complete suspected-candidate and variant ledger | `CODE_HUNT.md` |
| **Attack** | Build and attack a disposable local lab; retain controlled runtime evidence | `CODE_ATTACK.md` |
| **Verify** | Independently refute or confirm every candidate in a fresh context and lab | `CODE_VERIFY.md` |
| **Report** | Synthesize verified risk, coverage, limitations, remediation, and structured exports | `CODE_AUDIT_REPORT.md` |

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
importer blocks credentials, redirects, hooks, submodules, Git LFS, non-HTTPS
transports, private/local destinations, and dependency installation. It seals
the exact commit and local ref mapping, including the history needed for local
merge-base analysis.

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
