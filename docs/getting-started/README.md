# Your first penetration test

This walkthrough starts with a fresh supported computer and ends with an authenticated Cyberful installation that can run a first penetration test and produce its report. Follow **one** operating-system path from beginning to end, then continue with [Run the first test](#run-the-first-test).

> Use Cyberful only against systems you are authorized to test. Before you begin, know the exact targets, exclusions, test window, account permissions, and traffic limits for the engagement.

## What this walkthrough installs

Cyberful needs four things on the host:

| Component | Why it is needed |
| --- | --- |
| **Docker** | Runs the isolated Cyberful security environment |
| **Node.js and npm** | Installs the small npm package that selects the native Cyberful executable |
| **Cyberful CLI** | Starts the TUI, owns sessions, and writes evidence and reports |
| **A model-provider login** | Authenticates the default `openai-codex` provider through its browser or device-code flow |

Do **not** install ZAP, Ghidra, Firefox, Python, Bun, a JDK, or offensive tools on the host. They are already inside the Cyberful runtime image. Docker Compose is not required.

Cyberful also does **not** require Chrome, Safari, Edge, or another personal browser for security testing. The release contains its browser driver and automatically downloads a pinned, open-source Chromium build on first launch (about 150 MB). Chromium is stored in Cyberful's cache and uses dedicated profiles, so Cyberful never drives or locks your everyday browser profile. A system browser is useful only to complete the model provider's OAuth or device-code login; if Cyberful cannot open it automatically, it prints the URL and code so you can open them in any browser.

Have these ready before starting:

- an administrator account on the computer;
- a browser and an account with access to the default OpenAI Codex provider;
- an unrestricted internet connection for the Docker, npm, runtime-image, and provider-authentication downloads;
- at least **40 GB of free disk space**. The first compressed runtime download can exceed 6 GB and needs substantially more space after extraction;
- the written authorization and scope for the penetration test.

The npm release supports these host platforms:

| Host | Supported architecture |
| --- | --- |
| macOS | Apple silicon (`arm64`) and Intel (`x86_64`) |
| Linux | `x86_64` with glibc |
| Windows | 64-bit x86 (`AMD64`) |

The runtime image also has an ARM64 Linux variant, but the npm release does not currently publish a Linux ARM64 CLI package. Linux ARM64 and musl-based systems such as Alpine therefore need a source build and are outside this fresh-host walkthrough.

## macOS: install everything

These steps work on a supported Apple silicon or Intel Mac.

### 1. Check the Mac

Open **Terminal** and run:

```sh
uname -m
df -h "$HOME"
```

`uname -m` must print `arm64` or `x86_64`. Confirm that the disk containing your home directory has at least 40 GB available.

### 2. Install and start Docker Desktop

1. Open the official [Docker Desktop for Mac installation page](https://docs.docker.com/desktop/setup/install/mac-install/).
2. Download the installer for **Apple silicon** when `uname -m` printed `arm64`, or **Intel** when it printed `x86_64`.
3. Open `Docker.dmg`, drag Docker to **Applications**, then start Docker.
4. Accept the terms and keep the recommended settings when Docker asks for its initial configuration.
5. Wait until Docker Desktop reports that the engine is running.

Verify both the Docker client and server:

```sh
docker version
docker info --format '{{.OSType}}'
docker run --rm hello-world
```

The second command must print `linux`, and the last command must finish with Docker's success message. Do not continue while `docker version` reports only a client or cannot contact the server.

### 3. Install Node.js and npm

Install the current Node.js LTS line with `nvm`. This also installs npm without requiring `sudo` for global npm packages:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.5/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 24
nvm alias default 24
node --version
npm --version
```

Both version commands must print a version. Cyberful requires Node.js 18 or newer; Node.js 24 is the current LTS line used by this walkthrough. See the official [Node.js download page](https://nodejs.org/en/download) if the `nvm` installer has been superseded.

### 4. Install Cyberful

```sh
npm install --global cyberful
cyberful --version
```

If the shell cannot find `cyberful`, close Terminal, open it again, and rerun `cyberful --version`.

### 5. Create the engagement and authenticate

Create a dedicated directory. Run the authentication commands **from this directory**, because Cyberful creates and loads its local `settings.yaml` here:

```sh
mkdir -p "$HOME/cyberful-engagements/acme-web"
cd "$HOME/cyberful-engagements/acme-web"
cyberful auth login
cyberful auth status
```

Cyberful opens the default provider's browser or device-code login. Complete the sign-in and return to Terminal. The final command must include:

```text
Provider: openai-codex
Status: available
```

The subscription credential is kept in Cyberful's owner-only credential store; it is not written to `settings.yaml`, prompts, transcripts, or reports.

Your Mac is ready. Keep this Terminal open and continue with [Run the first test](#run-the-first-test).

## Linux: install everything

The published npm package requires a 64-bit x86 Linux distribution with glibc. The Docker steps below cover current Ubuntu, Debian, and Fedora releases.

### 1. Check the Linux host

Open a terminal and run:

```sh
uname -m
ldd --version | head -n 1
df -h "$HOME"
```

`uname -m` must print `x86_64`, `ldd` must identify glibc or GNU libc, and the disk containing your home directory must have at least 40 GB available.

### 2. Install Docker Engine

Use the block for your distribution. These commands add Docker's official package repository and install Docker Engine, its CLI, containerd, Buildx, and the Compose plugin. Cyberful itself does not require Compose.

#### Ubuntu

Follow this path on a currently supported Ubuntu release:

```sh
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

The commands follow Docker's official [Ubuntu installation procedure](https://docs.docker.com/engine/install/ubuntu/).

#### Debian

Follow this path on a currently supported Debian release:

```sh
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

The commands follow Docker's official [Debian installation procedure](https://docs.docker.com/engine/install/debian/). On a Debian-derived distribution, use the corresponding Debian codename as Docker documents; do not assume that an unsupported derivative is equivalent to Debian.

#### Fedora

Follow this path on a currently supported Fedora release:

```sh
sudo dnf install -y curl
sudo dnf config-manager addrepo --from-repofile https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

When prompted to accept Docker's GPG key, compare the fingerprint with the one published in Docker's official [Fedora installation procedure](https://docs.docker.com/engine/install/fedora/) before accepting it.

#### Allow your user to run Docker

Cyberful must be able to reach Docker without `sudo`. Add the current user to Docker's group:

```sh
sudo usermod -aG docker "$USER"
```

Sign out and back in, or activate the new membership immediately by running:

```sh
newgrp docker
```

The command opens a refreshed shell. Test the engine from that shell:

```sh
docker version
docker info --format '{{.OSType}}'
docker run --rm hello-world
```

The second Docker command must print `linux`, and `hello-world` must finish successfully. The `docker` group grants root-level privileges; read Docker's [Linux post-installation warning](https://docs.docker.com/engine/install/linux-postinstall/) before adding users on a shared host. The group membership is persistent, but you may need to sign out and back in for new terminals to see it.

### 3. Install Node.js and npm

Install the current Node.js LTS line with `nvm`:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.5/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 24
nvm alias default 24
node --version
npm --version
```

Both version commands must print a version. Cyberful requires Node.js 18 or newer; Node.js 24 is the current LTS line used by this walkthrough. See the official [Node.js download page](https://nodejs.org/en/download) if the `nvm` installer has been superseded.

### 4. Install Cyberful

```sh
npm install --global cyberful
cyberful --version
```

If a new terminal cannot find Node.js or Cyberful, sign out and back in, then rerun the two version checks. Do not reinstall the npm package with `sudo`.

### 5. Create the engagement and authenticate

Create a dedicated directory and authenticate from inside it:

```sh
mkdir -p "$HOME/cyberful-engagements/acme-web"
cd "$HOME/cyberful-engagements/acme-web"
cyberful auth login
cyberful auth status
```

Complete the browser or device-code login. The status output must include:

```text
Provider: openai-codex
Status: available
```

Cyberful stores the subscription credential in its owner-only credential store, not in the local `settings.yaml` it creates for the engagement.

Your Linux host is ready. Keep this terminal open and continue with [Run the first test](#run-the-first-test).

## Windows: install everything

This path installs and runs Cyberful natively in 64-bit Windows PowerShell. WSL 2 provides Docker Desktop's backend; a Linux distribution is not required for this walkthrough.

### 1. Check Windows and enable WSL 2

Confirm that virtualization is enabled in the computer's firmware and that the machine satisfies Docker Desktop's current [Windows system requirements](https://docs.docker.com/desktop/setup/install/windows-install/). Then open **PowerShell as Administrator** and run:

```powershell
$env:PROCESSOR_ARCHITECTURE
Get-PSDrive -Name C
wsl --install --no-distribution
```

The architecture must be `AMD64`, and the drive that will hold Docker data and your workarea needs at least 40 GB free. Restart Windows if `wsl --install` requests it. After the restart, reopen PowerShell as Administrator and run:

```powershell
wsl --update
wsl --version
```

If `wsl --install` is unavailable or fails, follow Microsoft's official [WSL installation instructions](https://learn.microsoft.com/windows/wsl/install) before continuing.

### 2. Install Node.js, npm, and Docker Desktop

In the administrator PowerShell window, install the current Node.js LTS release and Docker Desktop from WinGet:

```powershell
winget install --exact --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements
winget install --exact --id Docker.DockerDesktop --source winget --accept-source-agreements --accept-package-agreements
```

If `winget` is missing, install or update **App Installer** as described in Microsoft's [WinGet documentation](https://learn.microsoft.com/windows/package-manager/winget/), then rerun the commands.

Close PowerShell, open a new ordinary PowerShell window, and verify Node.js and npm:

```powershell
node --version
npm --version
```

Both commands must print a version. Cyberful requires Node.js 18 or newer; the WinGet LTS package installs a supported release.

### 3. Start and verify Docker Desktop

1. Start **Docker Desktop** from the Windows Start menu.
2. Accept the terms and finish the initial setup.
3. In **Settings > General**, keep **Use the WSL 2 based engine** enabled.
4. If the Docker Desktop menu offers **Switch to Linux containers**, select it. If it offers **Switch to Windows containers**, Linux containers are already active.
5. Wait until Docker Desktop reports that the engine is running.

Return to PowerShell and run:

```powershell
docker version
docker info --format '{{.OSType}}'
docker run --rm hello-world
```

The second command must print `linux`, and the last command must finish with Docker's success message. Cyberful cannot use the Windows-container engine.

### 4. Install Cyberful

```powershell
npm install --global cyberful
cyberful --version
```

If PowerShell cannot find `cyberful`, close it, open a new PowerShell window, and rerun `cyberful --version`.

### 5. Create the engagement and authenticate

Create a dedicated directory and authenticate from inside it:

```powershell
New-Item -ItemType Directory -Force "$HOME\cyberful-engagements\acme-web" | Out-Null
Set-Location "$HOME\cyberful-engagements\acme-web"
cyberful auth login
cyberful auth status
```

Complete the browser or device-code login. The status output must include:

```text
Provider: openai-codex
Status: available
```

Cyberful stores the subscription credential in its owner-only credential store, not in the local `settings.yaml` it creates for the engagement.

Your Windows host is ready. Keep this PowerShell window open and continue with the next section.

## Run the first test

All three installation paths leave the terminal in the engagement directory. Keep using that same directory for the remaining steps.

### 1. Run the final readiness check

On macOS or Linux:

```sh
cyberful --version
cyberful auth status
docker version
docker info --format '{{.OSType}}'
```

On Windows PowerShell:

```powershell
cyberful --version
cyberful auth status
docker version
docker info --format '{{.OSType}}'
```

Authentication must be `available`, Docker must report both a client and a server, and the Docker OS type must be `linux`.

### 2. Launch the TUI

```sh
cyberful
```

Before opening the TUI, Cyberful validates `settings.yaml`, resolves the main provider credential, verifies Docker, and prepares the immutable runtime image. The first compressed image download can exceed 6 GB, so the first start can take much longer than later ones. Leave Docker and the terminal running while the pull and image attestation complete. On first use, Cyberful also downloads about 150 MB for its isolated Chromium browser and stores it in its persistent cache; no browser installation step is required.

If the preflight stops, fix the specific failed check and run `cyberful` again. Cyberful does not begin a security workflow with a missing provider credential or an unavailable Docker server. A failed Chromium download is reported as a degraded browser capability: relaunch Cyberful to retry before starting a test that needs browser automation.

### 3. Name the workarea

The home screen asks for a **Workarea**. Use a short, engagement-specific name:

```text
acme-web-july-2026
```

The workarea is the durable memory shared by every phase. Cyberful creates it under:

```text
work/acme-web-july-2026/
```

It will contain the mission, phase artifacts, evidence, proof-of-concept material, and final report. A workarea is a name, not a path, so do not use `/`, `\`, or `..`.

### 4. Select Pentest

Pentest is selected by default in a standard installation. Check the workflow shown in the composer before starting.

From the home screen, press `Tab` to cycle through the available workflows, or type `/workflows` and select **Pentest**.

The selection is locked when the session starts. A Pentest always begins with Brief and advances through this chain:

```text
brief → recon → exploit → hacker → verify → report
```

### 5. Describe the engagement

The first message becomes the input for Brief. State the authorization and scope precisely. For example:

```text
Perform an authorized penetration test for Acme Web.

Objective:
- Validate tenant isolation and authenticated account flows.

In scope:
- https://staging.example.test
- api.staging.example.test

Out of scope:
- Production systems
- Denial-of-service and social engineering

Rules of engagement:
- Test window: 2026-07-20, 08:00–18:00 UTC
- Maximum 5 requests per second
- Do not modify or delete customer data
- Ask before testing third-party integrations

Access:
- A standard test account and a tenant-administrator account are available.
- Credentials are supplied for both accounts; store them as session variables
  and complete ordinary login flows autonomously.

Deliverable:
- Technical findings, executive summary, and remediation guidance.
```

Include exact URLs, account roles, expected security boundaries, and any steps needed to reproduce the behavior you want tested. Type `@` in the composer to attach an existing scope file or other engagement material.

Brief does not run security tests. When you declare one or more existing browser accounts, it makes one normal application visit per supplied profile to verify that the target session is authenticated, visibly distinct where promised, and routed through ZAP. When sufficient credentials were supplied, Brief stores them as session variables and completes the normal login autonomously through host-resolved `{{var:name}}` references. It opens a blocking **OK, retry** question only for a human-only challenge, missing second factor, rejected or locked access, unavailable profile, or degraded proxy. Brief rechecks only the failed readiness step and does not create the required `MISSION.md` or advance to Recon while declared access remains broken.

The same normal journey inventories application dependencies for downstream reasoning. Automatically contacted CDNs, backends, status services, and third parties do not block Recon, but they remain passive evidence rather than direct testing targets unless the supplied authorization independently covers them.

When the mission is clear, submit the message with `Enter`.

### 6. Follow the phases

Cyberful advances automatically after each phase writes its required artifact and completes a valid handoff:

| Phase | What it does |
| --- | --- |
| **Brief** | Records scope, authorization, access, and rules of engagement |
| **Recon** | Maps the surface and calibrates evidence-backed candidates |
| **Exploit** | Confirms candidates with controlled, reproducible evidence |
| **Hacker** | Investigates attack chains and higher-order hypotheses |
| **Verify** | Independently retests every confirmed claim |
| **Report** | Produces the final client-facing report |

The activity feed shows the current phase, public reasoning updates, tool use, warnings, and saved evidence. If Cyberful needs a blocking decision, it opens a question panel in the TUI.

Independent approvals are presented separately. Each approval identifies the host, method, browser identity or credential, expected effect, risk, and traffic bound when applicable, so accepting or declining one request cannot decide an unrelated backend, OAuth, MCP, or credential action.

You can send a message while a phase is running to correct an endpoint, clarify an account state, or tighten a traffic constraint. Submitted input steers the active phase; it does not silently expand the authorized scope.

Press `Ctrl+P` whenever you need the context-aware list of actions available on the current screen.

### 7. Open the report

When Report finishes, Cyberful displays a completion card with the validated result. The primary Pentest deliverable is:

```text
work/acme-web-july-2026/reports/security-report.pdf
```

The same workarea also contains the phase documents and supporting evidence:

```text
MISSION.md
RECON.md
EXPLOIT.md
HACKER.md
VERIFY.md
REPORT.md
evidence/
poc/
reports/
```

After completion, the session switches to **Ask**. You can use it to explore a finding, locate evidence, discuss remediation, or plan a follow-up test without losing the completed workarea.

## If a readiness check fails

| Symptom | What to do |
| --- | --- |
| `cyberful: command not found` or “not recognized” | Open a new terminal. Confirm `node --version` and `npm --version`, then rerun `npm install --global cyberful`. |
| Docker shows a client but no server | Start Docker Desktop on macOS or Windows; on Linux run `sudo systemctl start docker`. |
| Docker reports `permission denied` on Linux | Run `newgrp docker`, or sign out and back in after adding the user to the `docker` group. |
| Docker OS type is `windows` | Switch Docker Desktop to Linux containers and wait for the engine to restart. |
| Authentication status is `missing` | From the engagement directory, rerun `cyberful auth login`, finish the browser/device flow, then run `cyberful auth status`. |
| The Chromium download fails | Confirm that the host can reach the download service, then relaunch Cyberful. The preflight retries until the isolated browser is available. |
| npm reports an unsupported platform | Confirm the host matches the release matrix near the top of this page. Source builds are documented in [Install Cyberful](install.md). |
| The first launch runs out of space | Free enough space to leave at least 40 GB available, start Docker again, then rerun `cyberful`. |

For alternative model providers, credential sources, and fallback routes, see [Agent providers and fallback](../user-guide/settings.md). For the responsibilities and boundaries of all three security workflows, continue with [Application security workflows](../user-guide/workflows.md).
