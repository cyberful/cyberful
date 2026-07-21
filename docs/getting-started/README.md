# Your first penetration test

This walkthrough takes you from a working Cyberful installation to completing
a first penetration test in the terminal interface.

> Use Cyberful only against systems you are authorized to test. Before you
> begin, know the exact targets, exclusions, test window, and traffic limits for
> the engagement.

## 1. Confirm the installation

Complete [Install Cyberful](install.md) and confirm that Cyberful, Codex, and
Docker are ready:

```sh
cyberful --version
codex --version
docker version
```

If a check fails, return to [What you need](requirements.md) before creating the
engagement directory.

## 2. Create an engagement directory

Use a dedicated directory for the engagement. Cyberful will keep its workarea,
evidence, logs, and reports below this directory.

```sh
mkdir -p ~/cyberful-engagements/acme-web
cd ~/cyberful-engagements/acme-web
```

You can place non-secret scope notes, API descriptions, sample requests, or
architecture diagrams here and attach them from the TUI when writing the
mission.

## 3. Launch the TUI

Start Cyberful from the engagement directory:

```sh
cyberful
```

Before opening the TUI, Cyberful checks that Codex is installed and
authenticated, verifies the Docker runtime, and prepares its container images.
On the first launch it may also download the isolated Chromium browser. The
first startup can therefore take longer than later ones.

If Codex is not authenticated or Docker is not running, Cyberful stops with an
actionable message. Fix the reported dependency and launch it again.

## 4. Name the workarea

The home screen asks for a **Workarea**. Use a short, engagement-specific name:

```text
acme-web-july-2026
```

The workarea is the durable memory shared by every phase. Cyberful creates it
under:

```text
work/acme-web-july-2026/
```

It will contain the mission, phase artifacts, evidence, proof-of-concept
material, and final report. A workarea is a name, not a path, so do not use `/`,
`\`, or `..`.

## 5. Select Pentest

Pentest is selected by default in a standard installation. Check the workflow
shown in the composer before starting.

From the home screen, press `Tab` to cycle through the available workflows, or
type `/workflows` and select **Pentest**.

The selection is locked when the session starts. A Pentest always begins with
Brief and advances through this chain:

```text
brief → recon → exploit → hacker → verify → report
```

## 6. Describe the engagement

The first message becomes the input for Brief. State the authorization and
scope precisely. For example:

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
- Ask me when credentials are required.

Deliverable:
- Technical findings, executive summary, and remediation guidance.
```

Include exact URLs, account roles, expected security boundaries, and any steps
needed to reproduce the behavior you want tested. Type `@` in the composer to
attach an existing scope file or other engagement material.

Brief does not send traffic to the target. It turns your request into
`MISSION.md`, records the rules of engagement, and asks a question when a
missing decision prevents it from fixing the scope.

When the mission is clear, submit the message with `Enter`.

## 7. Follow the phases

Cyberful advances automatically after each phase writes its required artifact
and completes a valid handoff:

| Phase       | What it does                                                  |
| ----------- | ------------------------------------------------------------- |
| **Brief**   | Records scope, authorization, access, and rules of engagement |
| **Recon**   | Maps the authorized surface and records suspected leads       |
| **Exploit** | Confirms candidates with controlled, reproducible evidence    |
| **Hacker**  | Investigates attack chains and higher-order hypotheses        |
| **Verify**  | Independently retests every confirmed claim                   |
| **Report**  | Produces the final client-facing report                       |

The activity feed shows the current phase, public reasoning updates, tool use,
warnings, and saved evidence. If Cyberful needs a blocking decision, it opens a
question panel in the TUI.

You can send a message while a phase is running to correct an endpoint, clarify
an account state, or tighten a traffic constraint. Submitted input steers the
active phase; it does not silently expand the authorized scope.

Press `Ctrl+P` whenever you need the context-aware list of actions available on
the current screen.

## 8. Open the report

When Report finishes, Cyberful displays a completion card with the validated
result. The primary Pentest deliverable is:

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

After completion, the session switches to **Ask**. You can use it to explore a
finding, locate evidence, discuss remediation, or plan a follow-up test without
losing the completed workarea.

For the responsibilities and boundaries of all three security workflows, continue with
[Application security workflows](../user-guide/workflows.md).
