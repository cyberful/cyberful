# Cyberful built-in configuration

This directory is the first-party contract for Cyberful's Pi Agent-backed security workflows. Source runs read it directly; `make build` embeds it into every binary.

## Structure

```text
cyberful/builtin/
  baseInstructions.md
  cyberful.json
  agents/
    pentest/       brief, recon, exploit, hacker, verify, report, budgets
    bug-bounty/    dedicated brief, recon, exploit, hacker, verify, report, and budgets
    code-audit/    scope, index, trace, hunt, attack, verify, report, budgets
    ask/           interactive follow-up persona and budget
  skills/*/SKILL.md
  skills/{ZAP,NUCLEI}.md
  example/         development-only attachment fixtures
```

## Persona contract

Each Markdown filename below a workflow or follow-up namespace is a phase or persona identifier used by the orchestrator. The host renders `baseInstructions.md` once for each phase, replacing its workflow authorization, hacker-profile, delegation, and workarea placeholders with the current runtime values. Workarea rules include the attested cyberful-os Linux architecture so agents can reject incompatible dynamic execution plans before invoking the lab. The invariant target-content trust boundary lives directly in the template. Cyberful compiles the rendered document, host-owned phase rules, skill catalog, and run overlay into one immutable system message. Pi defaults, personal instructions, and ambient project configuration are not added.

Persona frontmatter declares a non-negative integer `subagents`. The host removes it from model-visible prose and combines it with the delegation limits in `settings.yaml`. Children remain inside the owning phase's workarea, private gateway, traffic policy, active-execution budget, and transcript boundary. Model, provider, tools, handoff, and context-sharing fields are not valid persona metadata.

The Pentest chain is:

```text
brief → recon → exploit → hacker → verify → report → complete
```

Its required artifacts are `MISSION.md`, `RECON.md`, `EXPLOIT.md`, `HACKER.md`, `VERIFY.md`, and `REPORT.md`.

The Bug Bounty Program chain is:

```text
brief → recon → exploit → hacker → verify → report → complete
```

Its dedicated Brief writes the Pentest-compatible `MISSION.md`. Dedicated Recon, Exploit, and Hacker personas apply a qualitative reward lens, host-validated bounty context, structurally checked portfolio convergence, and one explicit closeout of remaining authorized reward opportunities while retaining the standard `RECON.md`, `EXPLOIT.md`, and `HACKER.md` artifacts. Exploit and Hacker roots request one independent artifact-only `portfolio-critic` in the first half and one advisory `finding-breaker` after their first positive finding; neither review is a host gate. Dedicated Verify separates mechanism reproduction from evidence of a violated security invariant and concrete unwanted attacker effect. Verify and Report write `BUG_BOUNTY_VERIFY.md`, portable submissions under `reports/bug-bounty/BBP-###.md`, and the terminal `BUG_BOUNTY_REPORT.md` index.

The Code Audit chain is:

```text
scope → index → trace → hunt → attack → verify → report → complete
```

Its required artifacts are `CODE_SCOPE.md`, `CODE_GRAPH.md`, `CODE_TRACE.md`, `CODE_HUNT.md`, `CODE_ATTACK.md`, `CODE_VERIFY.md`, and `CODE_AUDIT_REPORT.md`.

`budgets.json` in each persona directory defines host-enforced active-execution ceilings. A constrained `handoff` accepts only the configured successor. The host waits for the current in-process Pi worker owner to shut down and the gateway to exit, validates and seals the required artifact, and only then starts the successor. A budget cutoff advances in degraded mode only when a partial artifact can be sealed and cleanup is complete.

## AgentRun contract

The original phase root, its primary children, fallback roots, and fallback descendants are all complete Pi `AgentRun` instances. Each receives a new compiled system message, persona, skill catalog, allowed tools, workarea contract, budget, and one bounded task. Children do not inherit their parent's full transcript or private reasoning.

Only the original root can call `handoff`. A fallback run may use tools, read skills, write permitted artifacts, and create descendants, but returns its structured result to its parent. Its entire tree keeps fallback provider affinity; routing never returns automatically to primary.

## Tools and trust

Every phase receives only the gateway capabilities registered for its workflow and phase. Pentest and Bug Bounty Program can use cyberful-os, the isolated browser, ZAP, and the persistent headless Ghidra project within their eligible phases and mission. Their eligible phases also expose complete firmware, native analysis/debugging, crash triage, fuzzing, binary-diff, protocol, appliance-fingerprint, and native-static MCP workflows. Bug Bounty additionally exposes pinned source imports, the managed EVM lab, and explicit EVM evidence indexing in their eligible phases. Code Audit uses bounded source and Code Graph tools, Ghidra from Index through Verify, the offline firmware/native/static laboratories, an offline Git diff tool in Scope, and a disposable runtime lab in Attack and Verify. It has no external target-traffic route and never edits the user's checkout.

Messages from the TUI steer the active root `AgentRun`. Blocking questions use the gateway's human-input bridge. Repository files, web content, tool output, and persisted target data remain untrusted evidence under the trust boundary encoded directly in the base template.

## Skills

Structured playbooks, including the canonical ZAP and Nuclei packages plus the first-party firmware laboratory, native debugging, binary analysis, native fuzzing, binary-protocol, and SAST workflows, live under `skills/*/SKILL.md` and are exposed through one compact catalog. Every root, subagent, and fallback run must read a selected `SKILL.md` in full before using it; packages retain their relevant `references/`, `agents/`, scripts, and assets. Repository-provided skills or prompts are never discovered automatically. Additional persona and skill roots must be explicitly trusted in `settings.yaml`.
