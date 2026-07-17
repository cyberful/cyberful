# Cyberful built-in configuration

This directory is the first-party contract for Cyberful's Codex-only
application-security workflow. Source runs use it directly; `make build`
embeds its text configuration into every binary. It contains the phase agents,
phase budgets, security skills, and shared developer instructions used by
the TUI.

## Structure

```text
cyberful/builtin/
  cyberful.json             Phase entry configuration
  agents/
    brief.md                Engagement framing and mission contract
    recon.md                Whole-surface reconnaissance
    exploit.md      Systematic exploitation
    hacker.md       Creative breakthrough pass
    verify.md       Independent adversarial verification
    report.md       Client report synthesis
    budgets.json            Host-enforced wall-clock ceilings
  instructions/
    cyberful.md             Shared developer instruction appended after every phase persona
  skills/*/SKILL.md         Structured security playbooks with specialist references
  skills/{ZAP,NUCLEI}.md    Flat tool contracts adapted into native Codex skills
  example/                  Development-only attachment fixtures (not embedded)
```

## Codex phase agents

Each Markdown filename under `agents/` is the phase identifier used by the
orchestrator. The host composes its body first and `instructions/cyberful.md`
second into Codex `developer_instructions` for the fresh app-server context.
Codex's model-specific base instructions remain intact; Cyberful does not set
`model_instructions_file`. Persona frontmatter declares a non-negative integer
`subagents`; the Codex subsystem removes it from model prose and turns it into
delegation instructions governed by the resolved Codex effort. The host also
owns model and effort settings, sandbox policy, tool exposure, phase order, and
process lifetime.

The pentest chain is:

```text
brief -> recon -> exploit -> hacker
      -> verify -> report -> complete
```

Every stage persists a named workarea artifact: `MISSION.md`, `RECON.md`,
`EXPLOIT.md`, `HACKER.md`, `VERIFY.md`, and `REPORT.md`. `budgets.json` defines
the wall-clock ceiling for each phase process; Recon has one 60-minute budget.

The constrained `handoff` tool accepts only the successor configured by the
host. Calling it records a request; it does not launch the next phase. The host
waits for the current Codex process and gateway tree to exit, validates the
deliverable and handoff record, and only then starts a fresh successor context.
Report terminates through `handoff` with target `complete`.

## Tools and interaction

Every phase reaches the authorized cyberful-os, browser, ZAP, session-variable,
human-question, and workarea capabilities through one host-owned MCP gateway.
Host tool implementations live in the TUI package rather than this project
configuration directory.
Native Codex children, when the persona and attested effort permit them, share
their root phase's filesystem, container, browser, ZAP state, egress, and
transcript. Personas determine which available capabilities are relevant;
Report performs no active testing.

Messages submitted from the TUI steer the one live root Codex turn; a message
submitted between phases waits for the successor. The composer shows steering as pending until the active
subsystem acknowledges it, and the session journal records it only after that
acknowledgement. Blocking Codex questions use the gateway's TUI-backed question
bridge. Public progress updates divide live phase activity into readable turns
without exposing private reasoning.

## Security skills

The structured playbooks under `skills/*/SKILL.md` are projected into a
temporary owner-only native Codex skill root at phase launch together with the
flat ZAP and Nuclei tool contracts. Packages retain their `references/` and
`agents/` trees. Accurate `agents/openai.yaml` metadata makes each specialized
methodology or tool workflow discoverable without injecting its full body into
every phase. Codex initially sees discovery metadata, loads a matching
`SKILL.md`, then reads only the specialist material required by the active
surface. Repository-native skills under `.agents/skills/` remain available
through the same progressive-disclosure mechanism.
