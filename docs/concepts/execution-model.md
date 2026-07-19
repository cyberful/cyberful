# How phases work

Cyberful breaks a security job into clear phases. Each phase starts with a fresh
Codex process and sees only the tools allowed for that part of the job.

```text
required artifact → handoff request or budget cutoff → host validation → process/gateway exit → next phase
```

A phase cannot move forward just by saying it is done. Cyberful checks the
required file and handoff, saves the result, closes the current process, and
only then starts the next phase. The real memory is the saved workarea and
evidence—not an invisible chat history.

The wall-clock budget is also a phase boundary. If it expires before the model
requests a handoff, Cyberful stops and reaps the process and gateway, verifies
and seals the required partial artifact, synthesizes the configured handoff,
and starts the successor in degraded mode. A missing artifact, failed seal,
invalid handoff, or gateway that cannot be proven stopped still halts the chain.

Phase cleanup owns only the declared output. For Markdown, Cyberful passes the
single required deliverable path to the normalizer; it never recursively edits
the workarea. Imported repositories, snapshots, prior artifacts, and arbitrary
Markdown therefore cannot be changed as a side effect of another phase ending.

Code Audit has one additional transition invariant. Before `index → trace`, the
host revalidates the source boundary and compares a signed, full-inventory
readiness record with the current Code Graph snapshot and coverage rows. The
check runs only after the phase gateway is proven stopped. Failure keeps Trace
closed, including for a budget-generated handoff.

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

For repository workflows, imported source and durable source snapshots live in
an owner-only host store outside the Codex writable root. The model receives no
native store path and reads source through bounded gateway calls. A durable
per-workarea import-attestation key stays in host state and is distinct from
the session finding-ledger key. Repository-provided agent files, skills, and
prompts are treated as target-controlled data rather than instructions.

## Delegated actors

Native Codex delegation is permitted only when the phase persona has a positive
subagent budget and reasoning effort is `ultra`. Children receive
self-contained tasks without inherited conversation history and remain inside
the owning phase's workarea, gateway, browser/ZAP state, and traffic policy.
They are attributed in the activity feed but do not become host phases or
separate Cyberful sessions.

`Escape` aborts the active process and descendants. `Ctrl+C` performs a full
shutdown and cleans up Cyberful-owned workers, gateways, containers, and
bridges, including while a blocking question is visible. A question belongs to
the phase that requested it; if that phase finishes or is cancelled before an
answer arrives, Cyberful retracts the question so it cannot block a successor.
