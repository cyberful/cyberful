# Cyberful

[![CI](https://github.com/cyberful/cyberful/actions/workflows/ci.yml/badge.svg)](https://github.com/cyberful/cyberful/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/cyberful.svg)](https://www.npmjs.com/package/cyberful)
[![Documentation](https://img.shields.io/badge/docs-cyberful.io-1463ff.svg)](https://cyberful.io/)

Cyberful turns your AI coding agent into an application-security workbench for
authorized penetration tests, code audits, and bug bounty programs.

> **Documentation:** installation, workflows, configuration, architecture, and
> security runtimes are documented at **[cyberful.io](https://cyberful.io/)**.

<p align="center">
  <img src="docs/assets/cyberful-demo.gif" alt="Cyberful running an authorized penetration test" />
</p>

Cyberful combines coding-agent reasoning with isolated offensive tooling,
independent verification, durable evidence, and report-ready outputs. It is
open source, local-first, and emits no telemetry.

| Workflow | Use it for |
| --- | --- |
| **Pentest** | Testing an authorized live target |
| **Bug Bounty** | Research governed by a supplied program policy |
| **Code Audit** | Reviewing a repository or an explicit diff |

## Getting started

The npm installation needs Node.js 18 or newer, npm, Docker, and a supported
model-provider account. Install Cyberful, create an engagement directory, and
authenticate the default OpenAI Codex provider:

```sh
npm install --global cyberful
mkdir -p "$HOME/cyberful-engagements/first-test"
cd "$HOME/cyberful-engagements/first-test"
cyberful auth login
cyberful auth status
cyberful
```

`cyberful auth status` must report `Status: available`. The first launch pulls
the Cyberful security image and installs its isolated Chromium browser. Keep at
least 40 GB of disk space free.

For complete fresh-machine instructions on macOS, Linux, and Windows, follow
**[Your first penetration test](https://cyberful.io/getting-started/)**.

Choose a workarea in the TUI, select a workflow, and describe the objective.
Every live-target request must include the exact authorized targets,
exclusions, test window, account roles, and traffic constraints. Bug bounty
requests should also supply the official program policy or its exact public
URL. Code Audit can review the complete repository or an explicitly requested
branch, commit range, or set of current changes.

## Why Cyberful

Modern coding agents can reason across applications, infrastructure, and source
code, but security conclusions are useful only when their scope and evidence
are trustworthy. Cyberful places that reasoning inside explicit authorization
boundaries, isolated tools, reproducible workflows, and an independent Verify
phase.

The goal is to make advanced security work more accessible without weakening
its standards. Findings remain inspectable, evidence-backed, and tied to the
engagement that authorized them.

## Pentest

Pentest evaluates an authorized live target through six sequential phases:

```text
brief → recon → exploit → hacker → verify → report
```

Brief records the scope, access, and rules of engagement. Recon maps the attack
surface; Exploit validates candidates; Hacker investigates higher-order chains;
Verify independently retests every claim; Report produces the client-facing
result.

The workflow can use cyberful-os, isolated Chromium profiles, headless OWASP
ZAP, and a persistent Ghidra project. Controlled tests inside the recorded
mission run autonomously; disruptive, value-moving, persistent-access, or
cross-scope actions require separate authority. The primary deliverable is:

```text
reports/security-report.pdf
```

Read the [Pentest workflow documentation](https://cyberful.io/user-guide/workflows/#pentest).

## Bug Bounty Program

Bug Bounty uses the live-target research phases with a Brief and Report tailored
to a supplied program policy:

```text
brief → recon → exploit → hacker → verify → report
```

Brief records safe harbor, eligible assets and vulnerability classes,
prohibited testing, data handling, and disclosure rules. Verify classifies each
candidate independently. Report creates one portable Markdown submission per
ready finding and a final index; Cyberful never submits findings to a platform
or predicts acceptance and rewards.

```text
BUG_BOUNTY_REPORT.md
reports/bug-bounty/BBP-###.md
```

Read the [Bug Bounty workflow documentation](https://cyberful.io/user-guide/workflows/#bug-bounty-program).

## Code Audit

Code Audit is read-only with respect to the user's checkout and supports a full
repository or an explicitly requested diff:

```text
scope → index → trace → hunt → attack → verify → report
```

It seals the source snapshot, builds a local Code Graph, traces security
boundaries and data flows, hunts relevant weakness classes, and validates the
strongest candidates. Attack and Verify may use phase-owned disposable labs;
project execution is offline and loopback-only, and mutable lab state is
destroyed when the phase closes.

The final outputs include a PDF report, Markdown summary, SARIF, and structured
evidence:

```text
reports/code-audit-report.pdf
CODE_AUDIT_REPORT.md
reports/code-audit.sarif
reports/code-audit-evidence.json
```

Read the [Code Audit workflow documentation](https://cyberful.io/user-guide/workflows/#code-audit).

## Requirements

To install through npm and run a release:

- Docker with a running Linux-container engine;
- Node.js 18 or newer with npm;
- one configured model provider;
- at least 40 GB of free disk space.

ZAP, Ghidra, Firefox, Python, and the offensive toolchain are included in the
runtime image. Cyberful downloads its own isolated Chromium browser on first
use, so it never needs access to a personal browser profile. Docker Compose is
not required.

See [What you need](https://cyberful.io/getting-started/requirements/) for the
supported host platforms, release architectures, provider setup, and source
development requirements.

## Build and test

From the repository root:

```sh
make deps       # install workspace and MCP dependencies
make typecheck  # run policy and TypeScript checks
make test       # run the complete test suite
make build      # build standalone release binaries
make run        # launch Cyberful from source
make docs       # serve the documentation locally
```

Source development requires Bun 1.3.14, Node.js 24 with npm, Python 3.10+, and
Docker. See the [contributing guide](CONTRIBUTING.md) for the complete build,
test, runtime, and release workflow.

## Configuration and local state

Cyberful creates a secret-free `settings.yaml` in the launch directory. It
defines providers, models, fallback routing, delegation, and trusted
instructions; provider credentials stay in Cyberful's protected credential
store or named environment variables. See [Agent providers and
fallback](https://cyberful.io/user-guide/settings/) and
[`.env-example`](.env-example).

Workareas live under `work/<name>/` and session logs under
`logs/session-logs/`. They can contain sensitive evidence. Never commit
workareas, transcripts, browser profiles, ZAP or Ghidra state, generated
reports, credentials, or tokens.

Resume an existing session with `cyberful run --continue` or
`cyberful run --session <id>`. Session lifecycle, out-of-band steering, CAPTCHA
handoffs, reports, and cleanup are covered in [Sessions, configuration, and
reports](https://cyberful.io/user-guide/sessions-and-reports/).

## Documentation

- **[Cyberful documentation](https://cyberful.io/)**
- [Your first penetration test](https://cyberful.io/getting-started/)
- [Application security workflows](https://cyberful.io/user-guide/workflows/)
- [Terminal interface](https://cyberful.io/user-guide/interface/)
- [Architecture](https://cyberful.io/concepts/architecture/)
- [Execution model](https://cyberful.io/concepts/execution-model/)
- [Security runtimes](https://cyberful.io/runtimes/)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License and responsible use

Cyberful is released under the [GNU Affero General Public License v3.0 only](LICENSE)
(`AGPL-3.0-only`). Use it only on systems and source you are authorized to
assess. You are responsible for scope, authorization, legal compliance, and
safe operation.
