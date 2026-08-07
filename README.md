# Cyberful: The Open-Source AI Red Team.

[![CI](https://github.com/cyberful/cyberful/actions/workflows/ci.yml/badge.svg)](https://github.com/cyberful/cyberful/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/cyberful.svg)](https://www.npmjs.com/package/cyberful) [![Documentation](https://img.shields.io/badge/docs-cyberful.io-1463ff.svg)](https://cyberful.io/)

For authorized pentests, code audits, and bug bounty research.

Cyberful combines coding-agent reasoning with isolated offensive tooling, independent verification, durable evidence, and report-ready outputs. It is open source, local-first, and emits no telemetry.

*(i) Documentation:* installation, workflows, configuration, architecture, and security runtimes are documented at **[cyberful.io](https://cyberful.io/)**.

<p align="center">
  <img src="docs/assets/cyberful-demo.gif" alt="Cyberful running an authorized penetration test" />
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

`cyberful auth status` must report `Status: available`. The first launch pulls the Cyberful security image and installs its isolated Chromium browser. Keep at least 40 GB of disk space free and dedicate at least 10 GB of RAM to Docker.

Open any persistent browser identity before a test with `cyberful browser-1` through `cyberful browser-5`. Sign in only to the authorized target account, then fully close the browser so Cyberful can reuse that profile during the test.

For complete fresh-machine instructions on macOS, Linux, and Windows, follow **[Your first penetration test](https://cyberful.io/getting-started/)**.

Choose a workarea in the TUI, select a workflow, and describe the objective. Every live-target request must include the exact authorized targets, exclusions, test window, account roles, and traffic constraints. Bug bounty requests should also supply the official program policy or its exact public URL. Code Audit can review the complete repository or an explicitly requested branch, commit range, or set of current changes.

## Requirements

To install through npm and run a release:

- Docker with a running Linux-container engine;
- Node.js 18 or newer with npm;
- one configured model provider;
- at least 40 GB of free disk space;
- at least 10 GB of RAM dedicated to Docker.

ZAP, Ghidra, Python, and the offensive toolchain—including the internal Firefox/Xvfb runtime used by ZAP—are included in the runtime image. Cyberful separately downloads an isolated Chromium browser for agent-controlled browsing on first use, so it never needs access to a personal browser profile. Docker Compose is not required.

See [What you need](https://cyberful.io/getting-started/requirements/) for the supported host platforms, release architectures, provider setup, and source development requirements.

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

Source development requires Bun 1.3.14, Node.js 24 with npm, Python 3.10+, and Docker. See the [contributing guide](CONTRIBUTING.md) for the complete build, test, runtime, and release workflow.

## Configuration and local state

Cyberful creates a secret-free `settings.yaml` in the launch directory. It defines providers, models, fallback routing, delegation, and trusted instructions; provider credentials stay in Cyberful's protected credential store or named environment variables. See [Agent providers and fallback](https://cyberful.io/user-guide/settings/) and [`.env-example`](.env-example).

Workareas live under `work/<name>/` and session logs under `logs/session-logs/`. They can contain sensitive evidence. Never commit workareas, transcripts, browser profiles, ZAP or Ghidra state, generated reports, credentials, or tokens.

Resume an existing session with `cyberful run --continue` or `cyberful run --session <id>`. Session lifecycle, out-of-band steering, CAPTCHA handoffs, reports, and cleanup are covered in [Sessions, configuration, and reports](https://cyberful.io/user-guide/sessions-and-reports/).

## Documentation

- **[Cyberful documentation](https://cyberful.io/)**
- [Your first penetration test](https://cyberful.io/getting-started/)
- [Application security workflows](https://cyberful.io/user-guide/workflows/)
- [Terminal interface](https://cyberful.io/user-guide/interface/)
- [Architecture](https://cyberful.io/concepts/architecture/)
- [Execution model](https://cyberful.io/concepts/execution-model/)
- [Security runtimes](https://cyberful.io/runtimes/)
- [CVE Dictionary](https://cyberful.io/runtimes/cve-dictionary/)
- [CVE Dictionary technical README](cyberful/src/cve-dictionary/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Support Cyberful

Love Cyberful? Give us a [⭐ on GitHub](https://github.com/cyberful/cyberful)!

## Acknowledgements

Cyberful builds on the incredible work of open-source projects like [Pi](https://github.com/earendil-works/pi), [OpenTUI](https://github.com/anomalyco/opentui), [Kali Linux](https://www.kali.org/), [Chromium](https://www.chromium.org/), [OWASP ZAP](https://www.zaproxy.org/), and [Ghidra](https://github.com/NationalSecurityAgency/ghidra). Huge thanks to their maintainers!

## License and responsible use

Cyberful is released under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). Use it only on systems and source you are authorized to assess. You are responsible for scope, authorization, legal compliance, and safe operation.
