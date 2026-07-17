# How phases work

Cyberful breaks a security job into clear phases. Each phase starts with a fresh
Codex process and sees only the tools allowed for that part of the job.

```text
required artifact → handoff request → host validation → process/gateway exit → next phase
```

A phase cannot move forward just by saying it is done. Cyberful checks the
required file and handoff, saves the result, closes the current process, and
only then starts the next phase. The real memory is the saved workarea and
evidence—not an invisible chat history.

Pentest uses the fixed chain `brief → recon → exploit → hacker → verify →
report`; the other phase sequences are documented in the
[workflow guide](../user-guide/workflows.md).

## Tools and network access

The private gateway combines first-party host tools, bounded Code Graph
queries, cyberful-os, the isolated browser, and ZAP where the phase is eligible.
Keys and dynamic ports remain host-owned. Code Audit and Secure Review receive
no target-traffic route; Assessment and Remediate require an explicit,
origin-scoped runtime authorization.

The gateway stops before the next phase starts, so tool registrations, traffic
grants, and ephemeral credentials do not leak across phases.

## Delegated actors

Native Codex delegation is permitted only when the phase persona has a positive
subagent budget and reasoning effort is `ultra`. Children receive
self-contained tasks without inherited conversation history and remain inside
the owning phase's workarea, gateway, browser/ZAP state, and traffic policy.
They are attributed in the activity feed but do not become host phases or
separate Cyberful sessions.

`Escape` aborts the active process and descendants. `Ctrl+C` performs a full
shutdown and cleans up Cyberful-owned workers, gateways, containers, and
bridges.
