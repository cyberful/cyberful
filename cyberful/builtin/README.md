# Cyberful built-in configuration

This directory is the first-party contract for Cyberful's Codex-backed
security workflows. Source runs read it directly; `make build` embeds it into
every binary.

## Structure

```text
cyberful/builtin/
  cyberful.json
  agents/
    pentest/       brief, recon, exploit, hacker, verify, report, budgets
    bug-bounty/    dedicated brief, verify, report, and shared-phase budgets
    code-audit/    scope, index, trace, hunt, attack, verify, report, budgets
    ask/           interactive follow-up persona and budget
  instructions/
    cyberful.md
    trust-boundary.md
  skills/*/SKILL.md
  skills/{ZAP,NUCLEI}.md
  example/         development-only attachment fixtures
```

## Persona contract

Each Markdown filename below a workflow or follow-up namespace is a phase or
persona identifier used by the orchestrator. The host composes the persona, delegation policy, shared
behavioral instructions, and final trust boundary into one fresh Codex
app-server context. Codex's model-specific base instructions remain intact.

Persona frontmatter declares a non-negative integer `subagents`. The host
removes it from model-visible prose and permits native delegation only when the
resolved reasoning effort is `ultra` and the value is positive. Children remain
inside the owning phase's workarea, private gateway, traffic policy, active-time
budget, and transcript boundary.

The Pentest chain is:

```text
brief → recon → exploit → hacker → verify → report → complete
```

Its required artifacts are `MISSION.md`, `RECON.md`, `EXPLOIT.md`,
`HACKER.md`, `VERIFY.md`, and `REPORT.md`.

The Bug Bounty Program chain is:

```text
brief → recon → exploit → hacker → verify → report → complete
```

Its dedicated Brief writes the Pentest-compatible `MISSION.md`; Recon, Exploit,
and Hacker resolve directly to the Pentest personas, including Recon's calibrated
candidate and retained-coverage contract. Dedicated Verify and Report
write `BUG_BOUNTY_VERIFY.md`, portable submissions under
`reports/bug-bounty/BBP-###.md`, and the terminal `BUG_BOUNTY_REPORT.md` index.

The Code Audit chain is:

```text
scope → index → trace → hunt → attack → verify → report → complete
```

Its required artifacts are `CODE_SCOPE.md`, `CODE_GRAPH.md`, `CODE_TRACE.md`,
`CODE_HUNT.md`, `CODE_ATTACK.md`, `CODE_VERIFY.md`, and
`CODE_AUDIT_REPORT.md`.

`budgets.json` in each persona directory defines host-enforced wall-clock
ceilings. A constrained `handoff` accepts only the configured successor. The
host waits for the current process and gateway to exit, validates and seals the
required artifact, and only then starts the successor. A budget cutoff advances
in degraded mode only when a partial artifact can be sealed and cleanup is
complete.

## Tools and trust

Every phase receives only the gateway capabilities registered for its workflow
and phase. Pentest and Bug Bounty Program can use cyberful-os, the isolated
browser, and ZAP within their mission. Code Audit uses bounded source and Code Graph tools, an offline Git
diff tool in Scope, and a disposable runtime lab in Attack and Verify. It has
no external target-traffic route and never edits the user's checkout.

Messages from the TUI steer the active root Codex turn. Blocking questions use
the gateway's human-input bridge. Repository files, web content, tool output,
and persisted target data remain untrusted evidence under
`instructions/trust-boundary.md`.

## Skills

Structured playbooks under `skills/*/SKILL.md` are projected into an owner-only
native Codex skill root at phase launch together with the flat ZAP and Nuclei
contracts. Packages retain their relevant `references/` and `agents/` trees.
Repository-provided skills or prompts are never projected into the phase
runtime.
