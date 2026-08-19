# Cyberful MCPs

MCP sources for Cyberful's unified security runtime and isolated browser.

## cyberful-os MCP

The main MCP server lives in `cyberful-os/`. In an ordinary engagement it attests and reuses the one host-owned tooling container. Standalone use retains lazy local container creation. The dependency-free stdio server exposes a lowercase registry for tools installed in the unified image.

The registry is intentionally granular: most MCP tools map directly to one CLI binary. Tool names are lowercase snake_case, while the catalog preserves the real command name to execute case-sensitive or hyphenated binaries.

Examples:

- `nmap` runs `nmap`
- `ffuf` runs `ffuf`
- `certipy_ad` runs `certipy-ad`
- `impacket_getuserspns` runs the CyberOS `impacket-GetUserSPNs` launcher with Kali's system Python
- `evil_winrm` runs `evil-winrm`
- `frida_ps` runs `frida-ps`
- `jwt_cracker` runs `jwt-cracker`
- `ghidra_run` runs `ghidraRun`
- `analyze_headless` runs `analyzeHeadless`
- `the_harvester` runs `theHarvester`

Each CLI tool uses the same input shape:

```json
{
  "args": ["--help"],
  "stdin": "optional stdin text",
  "cwd": "/workspace",
  "timeout_seconds": 120,
  "max_output_bytes": 262144,
  "env": { "NAME": "value" }
}
```

The MCP server currently declares 224 tools: 203 CLI wrappers, three Python-library tools (`requests`, `bs4`, and `lxml`), thirteen managed specialist workflows, and five utility tools (`wordlists`, `capability_attestation`, optional `nuclei_templates`, `tool_inventory`, and the fallback `shell`). The public build exposes 223 because the optional JEB wrapper remains hidden until a private image proves it available.

TLS / web / recon scanners (added to the network/web surface):

- `testssl` runs `testssl.sh` — TLS/SSL protocol, cipher, and certificate scan
- `sslscan` runs `sslscan` — TLS/SSL cipher and protocol enumeration
- `nuclei` runs the complete ProjectDiscovery Nuclei CLI. Cyberful injects only `-disable-update-check`; templates, rate, concurrency, redirects, OAST, tags, markers, and other assessment choices remain caller-controlled under the mission.
- `nuclei_templates` is an optional side-effect-free `nuclei -tl` preview of the installed template corpus. It is never a prerequisite for `nuclei`.
- `httpx` runs `httpx-pd` (`httpx-toolkit`) — fast HTTP probing/fingerprint
- `subfinder` runs `subfinder` — passive subdomain enumeration (ProjectDiscovery)

The three ProjectDiscovery tools (`nuclei`, `httpx`, `subfinder`) are telemetry-hardened in the image: update checks are disabled via the `DISABLE_UPDATE_CHECK=true` env and per-tool `~/.config` files, and `PDCP_API_KEY` is empty. Nuclei also receives `-disable-update-check` automatically. These settings prevent product telemetry without constraining assessment traffic or OAST choices authorized by the mission. Prowler's public launcher also answers `-v`/`--version` from installed package metadata, avoiding the upstream CLI's implicit GitHub tag request while delegating actual provider scans unchanged.

**nuclei templates** are installed at build from the pinned, SIGNED release tarball (`NUCLEI_TEMPLATES_VERSION`, currently `v10.4.5`) — curl'd from the nuclei-templates GitHub releases and extracted into nuclei's managed location (`/root/.local/nuclei-templates`), with `.nuclei-ignore` + a templates-config stub mirrored into `~/.config/nuclei` so runtime invocations resolve the corpus without `-t`. This is deliberately **not** `nuclei -update-templates`: the packaged nuclei self-updater is stubbed, so that command exits 0 without downloading anything and would silently ship a templates-less image. (A raw git clone of the template _source_ is likewise NOT valid — missing `# digest:` signatures/metadata makes most templates error and only a handful execute.) The build fails loudly if the fetch fails or lands zero templates (no silent empty-corpus image), and needs GitHub egress _at build time_; at runtime nuclei is invoked with `-disable-update-check`, so it never checks versions or fetches — fully offline. The corpus is **pinned** to `NUCLEI_TEMPLATES_VERSION`: reproducibility comes from that tag plus the sha256-pinned base image (which pins the nuclei engine). Bump the ARG and rebuild (`./bin/cyberful-os-build`) to refresh to a newer signed release.

Use `tool_inventory` to list registered MCP names, real commands/modules, categories, aliases, optional tools, and live availability inside the current container. `jeb` is optional and only resolves when a private image build includes JEB. Optional tools fail closed during discovery until the shared runtime preflight proves their command or module is installed; an explicit `capability_attestation` refreshes that same snapshot.

Thirteen managed specialist MCP workflows sit above the command catalog: `firmware_lab`, `native_lab`, `native_debug`, `crash_triage`, `fuzz_campaign`, `binary_diff`, `protocol_campaign`, `appliance_fingerprint`, `native_static_analysis`, `harness_validate`, `archive_extract`, `firefox_lab`, and `x11_clipboard`. They keep state below `/workspace`, retain structured evidence, own background process groups, and reap them when the phase bridge exits. Operation-specific schemas reject incomplete calls before execution. `archive_extract` detects signatures and atomically handles ZIP, TAR and compressed TAR variants, gzip/bzip2/xz streams, 7z, RAR, CAB, and ar while rejecting unsafe or oversized members. The matching built-in skills define safe sequencing, controls, checkpoints, and handoff evidence.

`capability_attestation` checks every required catalog command and Python module and smoke-tests Nuclei and Metasploit without target traffic. The Dockerfile runs the same catalog verifier at the end of every image build, and Cyberful repeats it before a phase starts; catalog/image drift is therefore a blocking error.

This is a breaking change from the older workflow-style API: tools such as `pentest_nmap_scan`, `osint_domain_recon`, `cred_dump_analyze`, and `javascript_trivy_scan` are no longer registered. Use the corresponding lowercase binary tools instead, such as `nmap`, `the_harvester`, `hydra`, `trivy`, or `retire`.

### Run the MCP server

```sh
mcps/cyberful-os/bin/cyberful-os
```

### Manage the container

```sh
mcps/cyberful-os/bin/cyberful-os-container status
mcps/cyberful-os/bin/cyberful-os-container up
mcps/cyberful-os/bin/cyberful-os-container shell
```

### Build the local image

```sh
make runtime-build
```

### Container defaults

- Name: `cyberful-os`
- Image: `cyberful-os:latest`
- Mount: `/workspace`
- Capabilities: `NET_ADMIN`, `SYS_PTRACE`
- Security options: `no-new-privileges`; core-only seccomp relaxation for nested user namespaces, without `SYS_ADMIN` or privileged mode

Set environment variables `CYBERFUL_OS_WORKSPACE`, `CYBERFUL_OS_CONTAINER`, `CYBERFUL_OS_IMAGE`, or `CYBERFUL_OS_MOUNT` to customise behaviour.

## browser MCP

The browser integration lives in `browser/`. It is a standalone stdio MCP server (`browser/browser_mcp.mjs`) that drives an isolated, stealth-hardened Chromium (patchright driver) and exposes `browser_*` tools for text / DOM / network automation plus `web_search` on a dedicated DuckDuckGo profile — there is no screenshot or vision. Pentest, Bug Bounty, and Ask call these tools directly; Code Audit remains offline.

### Install

From the repository root:

```sh
npm --prefix mcps install
npm --prefix mcps run browser:install
```

`npm --prefix mcps install` installs `patchright-core` (the stealth driver); `browser:install` downloads the driver's Chromium into `browser/.browsers/`. The bundled Chromium runs fully offline after install (no telemetry); `CYBER_BROWSER_CHANNEL=chrome` instead uses real Google Chrome, which makes its own update/safebrowsing requests (none of our engagement data).

### Run the MCP server

```sh
npm --prefix mcps run browser
```

Or directly:

```sh
mcps/browser/bin/cyber-browser
```

### Tools

`web_search` (only on the named search identity), `browser_status`, `browser_navigate`, `browser_snapshot` (rendered DOM / page text), `browser_click`, `browser_fill`, `browser_type`, `browser_select`, `browser_set_input_files`, `browser_scroll`, `browser_check`, `browser_press`, `browser_wait`, `browser_network_log`, `browser_network_response_body`, `browser_cookies`, `browser_evaluate`, `browser_artifact_list`, `browser_artifact_read`, `browser_captcha_status`, `browser_captcha_handoff`, `browser_close`.

After an ordinary page action makes a CAPTCHA visible, `browser_captcha_handoff` attests it and brings Chromium to the front. The agent then asks through the TUI with `question` kind `captcha`; a host breaker waits without a short browser timeout and releases active tools only after `browser_captcha_status` observes the clear state. It never solves, bypasses, or injects tokens. This is why the server runs **headed by default** (`CYBER_BROWSER_HEADLESS=false`).

## OWASP ZAP service and bridge

The `zap/` sources are bundled into cyberful-os. The engagement supervisor starts ZAP when live traffic is enabled, and gateways create bridge processes with `docker exec`. Browser traffic is proxied automatically with trust scoped to the engagement ZAP CA SPKI; core clients receive the same attested public CA through an engagement-only read-only bundle, while ZAP's private key remains masked from the core.

ZAP and browser proxying are enabled by default. Set `CYBER_ZAP_ENABLED=0` to disable the runtime or `CYBER_BROWSER_THROUGH_ZAP=0` to leave ZAP available without chaining the browser. See [`docs/runtimes/zap.md`](../docs/runtimes/zap.md).

## Ghidra service and bridge

The `ghidra/` sources are bundled into the same image with Kali's native Ghidra/PyGhidra package for amd64 and arm64. Cyberful keeps one JVM and project alive across eligible phases. Removing and recreating the engagement container does not delete the separately mounted host-owned project store.

The MCP exposes bounded semantic tools for import, job control, search, disassembly, decompilation, cross-references, call graphs, and annotations. It does not expose arbitrary scripts or binary mutation. See [`docs/runtimes/ghidra.md`](../docs/runtimes/ghidra.md).

### Stealth / anti-detection

Runs the [patchright](https://pypi.org/project/patchright/) driver by default so the browser is not fingerprinted as automation and blocked before an authorized target is reachable (removes `navigator.webdriver`, the `Runtime.enable` CDP leak, and the automation command flags). `CYBER_BROWSER_CHANNEL=auto` prefers real Google Chrome when installed, else patchright's bundled Chromium. It does **not** auto-solve CAPTCHAs — real challenges still go through `browser_captcha_handoff`. Disable with `CYBER_BROWSER_STEALTH=false`.

### Isolation

Everything the browser persists lives outside the user's own Chrome profile. Cyberful exposes five target identities plus `search` through the optional `profile: 1..5 | "search"` argument on every `browser_*` tool; each MCP process still owns one profile, and `web_search` is forced to `search`:

- Browser cache: `mcps/browser/.browsers`
- Installed profiles: `~/.cyberful/browser/profiles/cyberful{,-2,-3,-4,-5}`
- Installed artifacts: `~/.cyberful/browser/artifacts/profile-{1..5}`
- Search profile and artifacts: `~/.cyberful/browser/{profiles/search,artifacts/search}`
- Standalone MCP defaults: `~/.local/state/cyberful-os/mcp/browser/{profile,artifacts}`

### Environment overrides

- `CYBER_BROWSER_MCP_ENABLED` — `=0` disables the MCP (on when `mcps/browser` is present)
- `CYBER_BROWSER_MCP_COMMAND` / `CYBER_BROWSER_MCP` — override the server command
- `CYBER_BROWSER_HEADLESS` — default `false`; `=true` runs Chromium headless
- `CYBER_BROWSER_BROWSERS_PATH` — Chromium install/cache location
- `CYBER_BROWSER_USER_DATA_DIR` — persistent profile dir
- `CYBER_BROWSER_USER_DATA_DIR_1` … `_5` — per-identity profile dirs (`_1` takes precedence over the legacy unsuffixed value)
- `CYBER_BROWSER_USER_DATA_DIR_SEARCH` — named search profile dir
- `CYBER_BROWSER_CLEAR_COOKIES_ON_START` — default `false`; set `true` only to discard the dedicated profile's target login
- `CYBER_BROWSER_ARTIFACTS_DIR` — saved artifacts / downloads
- `CYBER_BROWSER_ARTIFACTS_DIR_1` … `_5` — per-identity artifact dirs
- `CYBER_BROWSER_ARTIFACTS_DIR_SEARCH` — named search artifact dir
- `CYBER_BROWSER_EXECUTABLE` — use a specific Chromium/Chrome binary
- `CYBER_BROWSER_PROXY` — route the browser through a proxy
- `CYBER_BROWSER_STEALTH` — default `true`; `=false` reverts to the stock driver + bundled Chromium
- `CYBER_BROWSER_CHANNEL` — `chromium` (default; bundled Chrome-for-Testing, no infobars), `auto` (prefer real Chrome), or `chrome` (force real Chrome)
- `CYBER_BROWSER_SANDBOX` — default `true`; `=false` launches with `--no-sandbox` (only if the OS sandbox can't start)
