# Cyberful

**Cyberful is an open-source application-security workbench for discovering,
exploiting, verifying, and remediating software vulnerabilities**.

<p align="center">
  <img src="docs/assets/cyberful-demo.gif" alt="Cyberful running an authorized penetration test" />
</p>

It covers the full application-security lifecycle: end-to-end **authorized
penetration testing**, repository-wide code audits, project and architecture
assessments, secure review of code changes, and verified remediation. The same
comprehensive suite supports professional security teams and independent
researchers working within bug bounty program scopes, without forcing them to
assemble a collection of disconnected scanners.

Rather than acting as a single scanner or rebuilding a general-purpose
autonomous agent, Cyberful uses a subsystem architecture. A subsystem is the
common boundary through which the host delegates phase execution to an external
runtime while retaining ownership of security workflows, policy, isolation,
evidence, and verification. This lets Cyberful build on mature systems instead
of reimplementing capabilities they already provide. Codex is currently the
only implemented subsystem; the architecture is designed to support additional
ones over time.

Across these workflows, Cyberful orchestrates a verified catalog of **177
cyberful-os tools** and makes them available under phase-specific policy, alongside
browser automation and headless OWASP ZAP. Isolated execution, a local Code
Graph, independent verification gates, durable evidence, and report-ready
outputs keep the work bounded and traceable.

## Getting started

After completing the [requirements](#requirements), run these commands from the
repository root:

```sh
npm install --global @openai/codex@0.144.5
codex
```

In Codex, choose **Sign in with ChatGPT**, complete the browser flow, then type
`/exit`. Back in the terminal, install the project dependencies and launch
Cyberful:

```sh
make deps
make run
```

Keep **Pentest** selected, create a workarea, and describe the authorized target
and its exact in-scope and out-of-scope boundaries.

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

When a workflow completes, Cyberful keeps the same scoped workarea available
through an interactive Ask workflow for follow-up investigation. The terminal user
interface (TUI) is built on OpenTUI, using its core, keymap, and Solid packages.

The repository root is the Bun/TypeScript workspace. The host owns
orchestration, session storage, policy, MCP lifecycle, live steering, and
reporting; model reasoning happens only inside one ephemeral Codex process per
phase. Cyberful does not embed or ship a model runtime. Its only currently
implemented subsystem, Codex, launches Codex CLI as an external runtime.

## Architecture

Cyberful is a host orchestrator built around a per-phase subsystem boundary.
The current implementation connects that boundary exclusively to Codex:

- **Orchestration** (`cyberful/src`) — the terminal control plane:
  session journal, phase sequencing, project and host policy, live activity
  feed, human questions, handoff gate, artifact validation, and reports.
- **Codex subsystem** (`cyberful/src/subsystem/`) — launches a fresh
  Codex app-server process for every sequential phase or Ask turn, maps its activity into
  TUI events and a phase transcript, forwards live user steering, and reaps the
  old process before a successor starts. The gateway under
  `src/subsystem/gateway/` exposes only the MCP tools approved for that phase.
- **Code Graph** (`cyberful/src/code-graph/`) — builds the local incremental
  repository graph, records per-file analysis coverage, serves bounded graph
  queries, persists local stage/resource progress, and owns the validated
  finding ledger and structured exports. Differential SQLite updates,
  checkpoints, WAL truncation, and an aggregate record budget bound indexing.
- **Host source store** (`cyberful/src/source-store.ts`) — keeps imported
  repositories and deterministic snapshots outside the model-writable workarea,
  addressed through read-only gateway tools and sealed with a durable
  per-workarea import key independent from the session finding ledger.
- **MCP collection** (`mcps/`) — the containerized cyberful-os toolbox, isolated web
  browser, and Dockerized OWASP ZAP runtime/bridge, reached through the host-owned gateway.
- **Built-in configuration** (`cyberful/builtin/`) — read-only phase personas, shared
  developer instructions, budgets, security skills, session-variable instructions, and MCP policy. `make build`
  bakes this directory into every binary (see [Configuration](#configuration-and-env)).

## Application security workflows

> [!IMPORTANT]
> Before using Cyberful, we recommend applying for
> [OpenAI Trusted Access for Cyber](https://openai.com/index/trusted-access-for-cyber/).
> Individual users can complete identity verification at
> [chatgpt.com/cyber](https://chatgpt.com/cyber). Trusted access does not replace
> target authorization, and all use must still comply with OpenAI's
> [Usage Policies](https://openai.com/policies/usage-policies/) and
> [Terms of Use](https://openai.com/policies/row-terms-of-use/).

| Workflow          | Phases                                                      |
| ----------------- | ----------------------------------------------------------- |
| **Pentest**       | Brief → Recon → Exploit → Hacker → Verify → Report          |
| **Code Audit**    | Scope → Index → Trace → Hunt → Verify → Report              |
| **Assessment**    | Brief → Map → Controls → Test → Correlate → Verify → Report |
| **Remediate**     | Intake → Plan → Implement → Verify → Publish                |
| **Secure Review** | Map → Audit → Verify                                        |
| **Ask**           | One interactive answer against an existing workarea         |

Every workflow phase starts with a fresh Codex context and normally advances by
calling the constrained `handoff` tool. The host validates the successor and
required artifact, terminates the current Codex process and gateway, seals the
artifact with a host-generated SHA-256 manifest, and only then launches the
next phase. If the wall-clock budget expires first, the host advances in
degraded mode only after the required partial artifact is sealed and the old
process and gateway are proven stopped; invalid handoffs or failed gates still
halt. Durable memory lives in workarea artifacts and the local Code Graph
rather than hidden model state.

Code Audit adds a host gate between Index and Trace: the source preflight must
still pass, and the current full-inventory graph snapshot and per-file coverage
must match a host-keyed readiness record. Markdown cleanup is ownership-scoped:
it can normalize only the required deliverable named by the phase contract and
never walks or rewrites the complete workarea.

Code Audit performs repository-wide static analysis. Assessment adds
architecture, supply-chain, infrastructure and compliance-readiness evidence,
plus active runtime testing only when the recorded scope authorizes it.
Remediate reproduces a finding before changing an isolated Git worktree and
offers push plus a draft PR/MR only after verification. Secure Review analyzes
the local merge-base diff and its graph-derived blast radius without using
forge APIs or implicitly fetching refs. Cyberful's exact workarea and
session-log roots are excluded from review inventories and recorded in the
review manifest; a tracked collision fails closed. Pre-publish Git processes disable lazy
promisor fetch, transports, all repository-declared clean/smudge/process filters,
external diff/text conversion, credential helpers, prompts, proxy
inheritance, and injected Git configuration; only the consented Remediate push
uses the host's network credentials. When the request names a public Git
repository instead of an existing checkout, the initial `scope`, `brief`,
`intake`, or `map` phase can ask the host to import one credential-free HTTPS
URL. The TUI fixes the hostname for explicit human approval, records the exact
commit/ref mapping, and all subsequent source analysis is offline. See
[Application security workflows](docs/user-guide/workflows.md)
for the full contracts and outputs.

Imported repositories and source snapshots are not placed under `work/`.
Cyberful stores their authoritative copies below its owner-only application
data directory and exposes them to Codex only through bounded read-only tools
using virtual `source://` identities. Repository `AGENTS.md`, skills, prompts,
and similar files remain untrusted audit evidence; they cannot become runtime
instructions. Source inventories retain `vendor/` and `.vscode/` instead of
silently excluding security-relevant tracked content.

The embedded language registry detects application code, C/C++ and systems
languages, cryptography and Web3 stacks, ROS/firmware/PLC/HDL projects, and
their build, infrastructure, API, and deployment artifacts. The current engine
uses deterministic semantic-lexer and declarative profiles: program semantics
are heuristic, declarative relationships are structural, and unsupported work
is reported as such. It does not claim compiler-grade frontends, native packs
that are not present, or WASM grammars. Every indexed file carries the actual
capability matrix and limitations.

On the welcome screen, `/workflows` opens the workflow selector and `/workflow`
is its shorter alias. The welcome hint advertises `/workflow`; `Tab` cycles the
same entries, and the empty composer updates its objective and example for the
current selection. Typing `/` in the composer opens command suggestions above
the composer and in front of adjacent welcome controls such as Workarea. The
selected workflow is locked when a session starts.

Every terminal outcome produces a persistent, color-coded completion card. Its
short Markdown summary links validated workarea artifacts, preferring the final
PDF report. The session then changes to Ask automatically. Each Ask response
uses a fresh Codex process with the latest run outcome and a bounded recent
conversation; the workarea remains the complete durable memory.

Each phase receives a workflow-specific capability allowlist. In all four AppSec
repository workflows, native Codex networking is disabled and cyberful-os runs without
a network. Code Audit and Secure Review have no target-traffic route; their
optional public repository import is a separate, one-time host operation.
Assessment `brief` and Remediate `intake` can invoke the host-owned
`runtime_authorization` gate for exact HTTP(S) origins and a bounded browser/ZAP
call budget. Only the designated later phases receive those host-scoped routes
after TUI consent; an ordinary session variable cannot grant access. Browser routing enforces the origin
boundary per request; ZAP applies it at the bridge/tool-call boundary rather
than claiming a packet-level firewall around every plugin. Pentest retains its
engagement traffic policy. Gateway tool calls automatically populate the local
metadata-only `raw/operations/tool-usage.csv` with timing,
outcome, and bounded result metrics but no tool arguments. Raw phase transcripts
may retain complete calls under the local transcript-retention setting. A message submitted
in the TUI is steered into the currently running Codex turn. While delivery is pending it remains below the
composer; it enters the feed and session journal only after the subsystem
acknowledges the live turn.

Personas persist a non-negative integer `subagents` value in Markdown
frontmatter. The Codex subsystem strips that metadata and, only when the
resolved effort is `ultra`, gives the phase permission to keep at most that many
direct children active concurrently. Cyberful opens Codex's native multi-agent
tools only for that authorized combination and explicitly closes them for every
other run. Those children share the owning phase's
workarea, gateway, browser, ZAP history, and egress. With lower effort or zero,
the generated instruction explicitly forbids spawning subagents.
Authorized children receive self-contained tasks with no forked parent history,
preserving the phase's ephemeral-thread boundary.

Subsystem activity has a provider-neutral delegated-actor contract. Codex maps
its native agent path, thread, turn, and collaboration events into stable child
labels and lifecycle states. The TUI places an `@label ↴` attribution directly
above every child tool card or standalone result, prefixes child prose with
`@label →`, and keeps simultaneous subsystem sources in separate feed groups; native
children do not become host sessions or phases. Gateway
startup status is visible for root and child threads. Final assistant records
persist one multi-dimensional token-usage step before their result.

The activity feed renders tool results according to their content: structured
data and source code use a dedicated Catppuccin Mocha palette, Markdown remains
document-shaped, and cyberful-os metadata is separated from non-empty output and
error streams. Generic tool results use bordered terminal cards by default;
long output stays bounded and expands on click. Host semantic-progress JSON
remains raw, with separate spacing and an informational color in the feed.

## Requirements

- Bun 1.3.14 or compatible (source builds only; the
  standalone binary already contains its runtime)
- Codex CLI, installed and authenticated at the exact version declared by
  `CODEX_PINNED_VERSION` in `cyberful/src/dependency/codex.ts` — the release Cyberful is
  validated against. The Codex subsystem owns a launch-time preflight for presence,
  version, and login, then publishes its detected runtime identity to the TUI; the
  build is gated on the same contract (see `make test-codex`).
- Python 3.10+ for the host-side cyberful-os server and container control
- Docker with Compose for cyberful-os and OWASP ZAP
- Node.js 18+/npm for the npm launcher and browser MCP

See the **[Requirements guide](docs/getting-started/requirements.md)** for installation and
verification instructions on macOS, Linux, and Windows.

## Build from source

From the repository root:

```sh
make deps        # install workspace and MCP dependencies
make subsystems  # update, contract-test, and pin registered host subsystems
make typecheck   # type-check the runtime, including unused-code checks
make test        # Bun/Python tests plus the live Docker cyberful-os contract
make test-all    # default suite plus loopback, ZAP, and Codex contracts
make build       # build standalone binaries for all platforms
make run         # launch from the repository root (dev)
```

GitHub CI/CD is temporarily disabled while the public repository is prepared.
Run the checks locally with the commands above; the preserved workflow definitions
and reactivation note live under [`.github/workflows`](.github/workflows/README.md).
See [Testing and CI](docs/development/testing.md).

`make subsystems` is the maintainer path for exact host-subsystem pins. It queries
each registered release channel, installs the candidate, verifies the live
compatibility contract, and only then updates its declared runtime and CI pins.
Documentation is never read, required, or rewritten by this command. A rejected
candidate leaves functional files unchanged and restores the previous installed
version when one was present. Use
`make subsystems SUBSYSTEMS=codex` to select only Codex as the registry grows.

`make run` is the dev workflow: it runs from source and reads the on-disk
`cyberful/builtin/` configuration. Install the isolated browser once with
`cd mcps && npm run browser:install`.

`make build` and `make install` are gated on `make test-codex`, which verifies the
installed Codex satisfies cyberful's phase contract — the pinned version, its
`--strict-config` config keys, the `app-server` JSON-RPC handshake, and a real MCP
spawn→connect→tool-discovery round-trip. That check needs Codex on `PATH` but **not**
a logged-in account (it stops before any model turn). Set `CYBERFUL_SKIP_CODEX_COMPAT=1`
to bypass it when cross-building on a host without Codex.

## Install or upgrade Cyberful

The supported distribution channel is the public npm package:

```sh
npm install --global @cyberful/cli
cyberful --version
```

Run the same installation command to upgrade. npm installs a small Node.js 18+
launcher and the native package for supported macOS, Linux, or Windows hosts.
On x64 it automatically selects the normal or baseline binary according to
AVX2 support.

To build and install the current checkout instead, run:

```sh
make install
```

This source installation places the current platform binary under
`~/.cyberful/bin` without `sudo`. Restart the terminal once if the installer
adds that directory to `PATH`.

On **Windows**, where `make` is usually absent, run the installer directly:

```sh
bun run cyberful/script/install.ts
```

See the [release policy](docs/development/release.md) for automatic
versioning, the supported package matrix, nightly and manual releases, and
publication integrity guarantees.

## Running an engagement

There are two supported ways to run Cyberful; they behave identically except
for where the configuration comes from:

|                   | `make run` (from source)    | `cyberful` (installed)              |
| ----------------- | --------------------------- | ----------------------------------- |
| Config            | on-disk `cyberful/builtin/` | baked into the binary at build time |
| Working directory | the repository root         | wherever you launch it              |

In **both** cases, the runtime state is created **in the current directory**:

```text
work/<slug>/            engagement workarea — artifacts and evidence
logs/session-logs/      per-session journals and Codex phase transcripts
reports/<timestamp>/    generated security reports
```

The exception is authoritative imported source and immutable source snapshots.
They live below the platform application-data directory in
`cyberful/source-store/<workarea-hash>/`, outside the Codex writable root; the
workarea contains reports, evidence, graph state, and phase artifacts, but not
a writable copy of those source acquisitions.

These directories hold sensitive engagement data and are git-ignored. The
installed binary does not load project configuration from the directory you
run it in — its configuration is the one baked in at build time.

### First launch: container images

The whole cyberful-os toolkit (bin scripts, Python MCP, Dockerfile, wordlists) is
baked into the binary by `make build` and unpacked to a cache directory on first
run, so the installed `cyberful` carries it — no repository checkout required. It
still needs Python 3 and Docker on the host.

On startup Cyberful runs one visible, blocking Docker preflight. It prepares
`cyberful-os:latest`, `cyberful-zap:2.17.0`, and
`cyberful-zap-bridge:0.1.0`, building missing images from contexts embedded in
the standalone binary. The first run pulls immutable base images and can take
several minutes; later launches use image-inspect fast paths. The preflight also
attests the complete cyberful-os CLI/library catalog and smoke-tests Nuclei,
Metasploit, static analysis, supply-chain, cloud/Kubernetes, and fuzzing
toolchains on the selected Linux `amd64` or `arm64` image. A stopped daemon,
failed image build, or missing required capability blocks startup before a
partial session is created.
The engagement session-creation boundary repeats the daemon reachability check,
so alternate local clients cannot bypass this invariant.

ZAP is enabled by default for traffic-capable workflows, runs only headless, and
needs no host Java, manual add-on installation, certificate import, or UI
consent. Pentest starts one isolated ZAP container and shares its history across
the complete chain. Assessment starts a phase-scoped container only for `test`;
Remediate starts separate phase-scoped containers for `plan` and `verify`.
Those AppSec containers are created only when the matching host-owned runtime
policy already exists and are stopped as their phase exits. Code Audit and
Secure Review do not start a target-traffic runtime. The browser is
automatically routed through the loopback-published proxy with trust scoped to
that runtime's CA SPKI. Each eligible phase's first `browser_status` attests the actual
proxy mode and resolved Chrome/Chromium runtime before target traffic.
Gateway-specific bridge names and labels provide explicit phase cleanup plus a
session-wide final sweep. ZAP keys live in an owner-only temporary gateway file,
not app-server arguments or the model environment. Docker unavailability blocks
startup. A later ZAP runtime failure marks the engagement degraded and browser
launches show direct fallback. The OAST bridge derives its callable operations
from the installed add-on catalog and exposes configuration/discovery only;
callback lifecycle tests use an engagement-owned one-shot harness. An individual
HTTP rejection closes its current experiment without globally disabling
independent authorized work. Disable ZAP with `CYBER_ZAP_ENABLED=0`, or keep ZAP
while disabling browser proxying with `CYBER_BROWSER_THROUGH_ZAP=0`.

While a phase is running, `Escape` immediately aborts its Codex, gateway, and
complete descendant process tree. A full `Ctrl+C` exit also tears down the
worker, engagement cyberful-os containers, ZAP, and disposable bridges, even
while a question is visible. Questions are retracted when their requesting
phase ends, so an unanswered prompt cannot remain as a stale blocker over a
successor. The main process keeps a live fallback inventory so a
wedged worker cannot leave Cyberful-owned processes or Docker workloads active.

### First launch: the browser

The browser MCP drives open-source **Chromium** (patchright's Chrome-for-Testing)
by default — no proprietary Chrome, and a dedicated `cyberful` profile under
`~/.cyberful/browser`. The driver ships inside the binary; only Chromium itself
(~150 MB) is fetched on first launch by a visible preflight, streaming the
download, then reused. Target cookies persist in that isolated profile by default,
while browser-owned background calls are disabled for both Chromium and Chrome so a
blank launch does not pollute ZAP history. Node.js must be on the host. To reuse a real, pre-logged-in
Google Chrome instead (skips login OTP, passes Cloudflare), set
`CYBER_BROWSER_CHANNEL=chrome` in the `.env` of the directory you launch from; it
uses the default Cyberful profile unless `CYBER_BROWSER_USER_DATA_DIR=<profile>` is
also set. Fully close the manually seeded browser before Cyberful starts so the
profile lock is released. Disable the preflight with
`CYBERFUL_SKIP_BROWSER_PREFLIGHT=1`. See **[Browser MCP](docs/runtimes/browser.md)** for the full reference:
choosing Chromium vs real Chrome, and how to open a dedicated Chrome and log into a target once so an
authorized bug-bounty / pentest engagement reuses that authenticated session.

### Resuming a session

Session state, including its persisted AppSec or Ask workflow, lives in a global
local SQLite database keyed by the launch directory — independent of `work/` and
`logs/`. It stores no Cyberful account or session-sharing state; on Unix the
database and its SQLite sidecars are restricted to mode `0600`. To resume, run
from the **same directory** you started in:

```sh
cyberful run --continue          # resume the last session in this directory
cyberful run --session <id>      # resume a specific session
```

An unfinished chain restarts at its recorded phase. A completed run reopens in
Ask with its completion card and the same `work/<slug>/` artifacts.

## Configuration and `.env`

The terminal UI follows the terminal's light or dark appearance, including when
it must infer that appearance from the background palette. Use `Ctrl+P` and
choose **Switch to light mode** or **Switch to dark mode** (or press `Ctrl+X`,
then `Shift+T`) to persist a manual choice. The same light palette is used by
the full TUI and `cyberful run`.

The first-party configuration lives under
[`cyberful/builtin/`](cyberful/builtin/):

```text
cyberful/builtin/
  agents/          personas and budgets for all workflows, including `ask/`
  skills/          advanced methodology and specialist tool playbooks
  instructions/    shared phase-developer and session instructions
  cyberful.json    MCP and project policy
```

`make build` bakes the text configuration from this directory into every binary,
so the installed `cyberful` carries it. In dev (`make run`) the directory is read
live, so edits take effect immediately; rebuild to ship them in the binary.

Runtime settings — Codex command, model, reasoning effort, phase budgets,
browser, ZAP, and cyberful-os — come from environment variables, documented in
[`.env-example`](.env-example). Cyberful layers `.env` files, highest
precedence first:

1. the real shell environment (exported variables always win);
2. a `.env` in the directory where you launch `cyberful`;
3. the `.env` baked into the binary at build time.

So the build ships sensible defaults, and dropping a `.env` next to where you
run `cyberful` overrides them per engagement — without rebuilding.

## Documentation

Documentation lives under [`docs/`](docs/README.md). The same Markdown is used
by GitBook through [`.gitbook.yaml`](.gitbook.yaml) and by the local preview:

```sh
make docs         # serve on http://127.0.0.1:8010
make docs-build   # build the static site into ./site
```

The preview is local-only, uses bundled assets, and has no analytics. GitBook
uses [`docs/README.md`](docs/README.md) as its homepage and
[`docs/SUMMARY.md`](docs/SUMMARY.md) as its navigation.

Start with [Your first penetration test](docs/getting-started/README.md), then
use [Application security workflows](docs/user-guide/workflows.md) to compare the
available modes.

## Contributing

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) for the mandatory code canon and
quick workflow. The engineer site provides the extended
[contributor guide](docs/development/README.md),
[test matrix](docs/development/testing.md), and
[release policy](docs/development/release.md).

Please follow the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Usage questions
and bug reports are routed in [`SUPPORT.md`](SUPPORT.md); disclose suspected
vulnerabilities privately according to [`SECURITY.md`](SECURITY.md).
Project ownership and review responsibility are listed in
[`MAINTAINERS.md`](MAINTAINERS.md).

## License

Copyright © 2026 Cyberful.

Cyberful is licensed under the **GNU Affero General Public License version 3
only** (`AGPL-3.0-only`). See [`LICENSE`](LICENSE) for the complete terms.
Redistributed fonts, wordlists, upstream-derived code, and their licenses are
listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Operational boundary

Cyberful is for authorized application-security work. Components must not emit
outbound telemetry, metrics, or analytics. Auxiliary services stay hardened
and localhost-only unless an engagement explicitly requires target traffic.

Repository guidance is in [`AGENTS.md`](AGENTS.md); MCP-specific rules are in
[`mcps/AGENTS.md`](mcps/AGENTS.md).

## Credits

Cyberful was originally partial derived from
[`anomalyco/opencode@7703786`](https://github.com/anomalyco/opencode/commit/7703786498e2d3609f649168e54919c344fe10ee)
on 2026-05-25. The upstream MIT notice is preserved in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
