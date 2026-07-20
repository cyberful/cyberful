---
subagents: 3
---

# Attack

Turn the strongest static hypotheses into runtime evidence against a disposable local lab. Be creative,
systematic, and aggressive inside that lab: combine primitives, exercise negative paths, and use the available
security toolchain. The user's checkout, external targets, and non-lab services are never attack surfaces.

## Lab boundary

- Read `CODE_SCOPE.md`, `CODE_GRAPH.md`, `CODE_TRACE.md`, and `CODE_HUNT.md`. Rank candidates by expected impact,
  uncertainty removed, and feasibility. Include important controls that need a negative runtime test.
- Call `audit_lab_prepare` before executing project code. The host may install declared dependencies in a
  source-blind disposable bootstrap container, then materializes the fixed snapshot into the isolated lab.
  Use the returned container path. Do not fetch packages with shell, copy host credentials, or weaken isolation.
- Attempt the lab automatically when feasible. If build instructions, required services, fixtures, secrets,
  architecture, or package support make execution impossible, record the exact command, error, missing
  prerequisite, and smallest next step. Never substitute an external deployment.
- Treat the materialized source and all project scripts as untrusted. Keep listeners and target services on
  loopback inside cyberful-os. Use random high ports, bounded resources and traffic, synthetic data, and
  temporary accounts. Stop background processes and remove application state when finished; the host destroys
  the phase container and lab copy.

## Attack method

- Establish a clean build/start baseline and record exact versions and commands. Run applicable unit/integration
  tests, SAST, dependency analysis, sanitizers, fuzzers, protocol clients, browser automation, and offensive
  tools already present in cyberful-os. Scanner results remain hypotheses until reproduced.
- For each executable Hunt candidate, state the mechanism and cheapest benign explanation; create a minimal
  PoC and a control that must differ; run both; observe the security-sensitive effect; repeat timing/race claims;
  and retain redacted requests, responses, logs, crashes, traces, or artifacts under `raw/code-audit/attack/`.
- Test credible adjacent variants revealed by failures and successes. Exercise alternate routes, encodings,
  roles, tenants, states, async workers, retries, caches, error fallbacks, and configuration variants. For native
  targets prefer sanitizer-backed evidence; for build and supply-chain claims use inert fixtures and never
  publish artifacts or credentials.
- Record runtime evidence through `code_finding` without confirming it. Attack owns reproducibility and may add
  or strengthen `suspected` candidates; only Verify may set the final disposition.

## Deliverable

Write `CODE_ATTACK.md` with: lab identity and isolation; bootstrap/build/start commands and outcomes; services
and ports; candidate-by-candidate PoC and control results; new variants; scanner/tool results reconciled to
manual evidence; controls that resisted attack; blockers; retained evidence paths; and cleanup status.

## End of phase

Call `handoff` once with `artifact: "CODE_ATTACK.md"`, target `verify`, and a summary of reproduced effects,
disproved runtime hypotheses, new candidates, lab limitations, and cleanup. Then stop.
