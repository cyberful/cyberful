<p align="center">
  <img src=".github/assets/cyberful-readme-logo-clean-v1.png" alt="Cyberful" width="720" />
</p>

# Cyberful: The Open-Source AI Red Team.

[![CI](https://github.com/cyberful/cyberful/actions/workflows/ci.yml/badge.svg)](https://github.com/cyberful/cyberful/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/cyberful.svg)](https://www.npmjs.com/package/cyberful) [![Documentation](https://img.shields.io/badge/docs-open--docs-1463ff.svg)](https://cyberful.ai/open-docs/)

For authorized pentests, code audits, and bug bounty research.

Cyberful combines coding-agent reasoning with isolated offensive tooling, independent verification, durable evidence, and report-ready outputs. It is open source, local-first, and emits no telemetry.

Bug Bounty research validates reward context and resolves convergence through tested pivots or evidenced exhaustion—without scores, rankings, or quotas.

*(i) Documentation:* installation, workflows, configuration, architecture, and security runtimes are documented at **[cyberful.ai/open-docs](https://cyberful.ai/open-docs/)**.

<p align="center">
  <img src=".github/assets/cyberful-demo.gif" alt="Cyberful running an authorized penetration test" />
</p>

Cyberful combines coding-agent reasoning with isolated offensive tooling, independent verification, durable evidence, and report-ready outputs. It is open source, local-first, and emits no telemetry.

## Why Cyberful

Cyberful exists to **democratize cybersecurity**: to make advanced security work understandable, inspectable, and usable by more developers, researchers, maintainers, and smaller teams. Democratization does not mean unrestricted automation or lower standards; findings remain evidence-backed, independently verifiable, and tied to the engagement that authorized them.

## Getting started

The npm installation needs Node.js 18 or newer, npm, Docker, and a supported model-provider account. Install Cyberful, create an engagement directory, and authenticate the default OpenAI Codex provider:

```sh
npm install --global cyberful
mkdir -p "$HOME/cyberful-engagements/first-test"
cd "$HOME/cyberful-engagements/first-test"
cyberful auth login
cyberful auth status
cyberful
```

`cyberful auth status` must report `Status: available`. The first launch builds the fingerprinted Cyberful security image locally with visible Docker logs and installs its isolated Chromium browser. Keep at least 100 GB of disk space free for the first build and dedicate at least 10 GB of RAM to Docker.

Open any persistent browser identity before a test with `cyberful browser-1` through `cyberful browser-5`. This is the fork's passive headed agent-browser mode, not a separate browser path: agent-browser owns process cleanup but does not attach to, navigate, or reset the visible tabs during human login. Cyberful also enables Chrome's native last-session restoration for numbered profiles so session cookies survive a clean close and restart. Sign in only to the authorized target account, then fully close the browser. The command waits until the passive daemon releases its socket and profile lock, after which Cyberful can reuse that profile during the test.

Public web research uses a sixth phase-temporary identity named `search`, kept separate from target accounts and routed directly through the eager `web_search` wrapper. It has no separate CLI command and is never included in target surface coverage.

Within a phase, each profile is one lazy, serialized agent-browser session shared by root, delegated, and fallback AgentRuns. Profiles `1`–`5` preserve their existing authenticated directories and are pinned fail-closed through ZAP; `search` is direct. The full browser catalog is discovered once through the direct search identity and reused for all six runtimes, while `web_search` is available immediately. During live web research, the gateway passively turns ZAP history into the canonical redacted HTTP surface map and records agent-browser only as semantic UI activity. Recon starts broad, Exploit and Hacker keep exploring product workflows while testing, and one positive host-owned continuation can reopen premature exhaustion without imposing route or click quotas.

For complete fresh-machine instructions on macOS, Linux, and Windows, follow **[Your first penetration test](https://cyberful.ai/open-docs/getting-started/)**.

Choose a workarea in the TUI, select a workflow, and describe the objective. The composer's fixed status shoulder reports the active phase, its elapsed time, and whether Cyberful is generating or executing a job without claiming a completion percentage. Every live-target request must include the exact authorized targets, exclusions, test window, account roles, and traffic constraints. Bug bounty requests should also supply the official program policy or its exact public URL; Brief reads published reward tiers autonomously, and finding maturation checkpoints make the technical frontier and potential published upside visible in the live feed. Code Audit can review the complete repository or an explicitly requested branch, commit range, or set of current changes.

## Requirements

To install through npm and run a release:

- Docker with a running Linux-container engine;
- Node.js 18 or newer with npm;
- one configured model provider;
- at least 100 GB of free disk space before the first runtime build;
- at least 10 GB of RAM dedicated to Docker.

ZAP, Ghidra, Python, Ruby/Bundler, native debugging and fuzzing, managed Firefox/Marionette, Xvfb/X11 clipboard testing, archive extraction, and the offensive toolchain are included in the runtime image. Before a live-target AgentRun starts, an ephemeral private-network HTTPS canary verifies that curl/OpenSSL, Git, Requests/pip, Node, and Ruby/Bundler can traverse the real ZAP proxy with the attested engagement CA; it never contacts the target or Internet. Brief then installs and attests the engagement's host-scoped rate limit and mandatory public request headers in ZAP before numbered target-profile preflight. After each accepted Pentest or Bug Bounty phase, the host records a best-effort passive ZAP checkpoint filtered to observed origins whose hostname is authorized by the finalized policy; non-web engagements make no checkpoint ZAP call or wait, and collection never blocks handoff. Cyberful embeds its pinned hardened agent-browser fork and prepares an isolated compatible Chrome for agent-controlled browsing, so it never needs access to a personal browser profile. Docker Compose is not required.

See [What you need](https://cyberful.ai/open-docs/getting-started/requirements/) for the supported host platforms, release architectures, provider setup, and source development requirements.

## Build and test

From the repository root:
```sh
make deps       # install workspace and MCP dependencies
./scripts/update_pi.py  # update and attest the latest Pi build embedded in Cyberful
make typecheck  # run policy and TypeScript checks
make test       # run the complete test suite
make build      # build standalone release binaries
make run        # launch Cyberful from source
```

`make build` resolves the current official ATT&CK releases once, validates and indexes the three domains, and embeds the resulting snapshot in every standalone binary. Source launches such as `make run` never download ATT&CK; they use the snapshot left by the latest successful build and report `DATASET_UNAVAILABLE` when none is available.

Source development requires Bun 1.3.14, Node.js 24 with npm, Python 3.10+, and Docker. See the [contributing guide](CONTRIBUTING.md) for the complete build, test, runtime, and release workflow.

## Configuration and local state

Cyberful creates a secret-free `settings.yaml` in the launch directory. It defines providers, models, fallback routing, delegation, trusted instructions, and the progressive skill-catalog budget; provider credentials stay in Cyberful's protected credential store or named environment variables. See [Agent providers and fallback](https://cyberful.ai/open-docs/user-guide/settings/) and [`.env-example`](.env-example).

Workareas live under `work/<name>/` and session logs under `logs/session-logs/`. They can contain sensitive evidence. Never commit workareas, transcripts, browser profiles, ZAP or Ghidra state, generated reports, credentials, or tokens.

The first local engagement also prepares the release-pinned CVE Dictionary in the foreground. Before downloading, Cyberful checks an explicit verified path, the managed pointer, verified orphan snapshots, and a source checkout's fixed `dist/cve-dictionary` directory; selecting an orphan repairs the missing pointer atomically. Release `2026.08.05` downloads about 5.18 GiB only when no verified local candidate exists, expands to about 24.47 GiB, requires approximately 31 GiB of additional free space during installation, and shows verified download and activation progress on stderr. Later startups reuse the local snapshot without a network update check.

Start a specific headless workflow with `cyberful run --workflow bug-bounty --workarea <name> "<objective>"`. Resume an existing session with `cyberful run --continue` or `cyberful run --session <id>`. Session lifecycle, queued or focused out-of-band steering, autonomous CAPTCHA handling and its human fallback, reports, and cleanup are covered in [Sessions, configuration, and reports](https://cyberful.ai/open-docs/user-guide/sessions-and-reports/).

## Documentation

- **[Cyberful documentation](https://cyberful.ai/open-docs/)**
- [Your first penetration test](https://cyberful.ai/open-docs/getting-started/)
- [Application security workflows](https://cyberful.ai/open-docs/user-guide/workflows/)
- [Terminal interface](https://cyberful.ai/open-docs/user-guide/interface/)
- [Architecture](https://cyberful.ai/open-docs/concepts/architecture/)
- [Execution model](https://cyberful.ai/open-docs/concepts/execution-model/)
- [Security runtimes](https://cyberful.ai/open-docs/runtimes/)
- [Built-in skill catalog](https://cyberful.ai/open-docs/runtimes/skill-catalog/)
- [CVE Dictionary](https://cyberful.ai/open-docs/runtimes/cve-dictionary/)
- [CVE Dictionary technical README](cyberful/src/cve-dictionary/README.md)
- [MITRE ATT&CK MCP](https://cyberful.ai/open-docs/runtimes/mitre-attack/)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Support Cyberful

Love Cyberful? Give us a [⭐ on GitHub](https://github.com/cyberful/cyberful)!

## Acknowledgements

Cyberful builds on the incredible work of open-source projects like [Pi](https://github.com/earendil-works/pi), [OpenTUI](https://github.com/anomalyco/opentui), the [Cyberful agent-browser fork](https://github.com/cyberful/agent-browser) and its [upstream project](https://github.com/vercel-labs/agent-browser), [Chromium](https://www.chromium.org/), [OWASP ZAP](https://www.zaproxy.org/), [Ghidra](https://github.com/NationalSecurityAgency/ghidra), and the [MITRE ATT&CK](https://attack.mitre.org/) knowledge base. Huge thanks to their maintainers!

## License and responsible use

Cyberful is released under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). Use it only on systems and source you are authorized to assess. You are responsible for scope, authorization, legal compliance, and safe operation.
