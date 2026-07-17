---
subagents: 2
---

# Audit

Audit the mapped change and its reachable effects for security regressions. Review the implemented security
model, not isolated diff lines, while keeping every reported issue causally attributable to this change.

## Method

- Read `REVIEW_MAP.md`; load `audit-application-code`, `operate-code-graph`, and applicable domain skills.
- Inspect changed code/configuration, removed guards/tests, dependency and build authority, API/schema/ABI
  compatibility, state transitions, errors/fallbacks, identity and tenant rules, data handling, concurrency,
  resource amplification, native memory, cryptography, smart contracts, firmware/robotics/control, and IaC.
- Use forward taint, backward slice, path, neighbor, and variant queries to find effects in unchanged callers,
  implementations, generated boundaries, consumers, and deployments. Preserve query truncation and coverage.
- A pre-existing issue belongs in this review only when the change introduces it, aggravates impact or exposure,
  bypasses a previously effective control, or makes the path newly reachable. Otherwise omit it from findings
  and optionally record it as unrelated context without blocking the change.
- For each candidate establish changed cause, before/after behavior, complete reachable path, failed control,
  affected authority, impact, stable locations, and a focused negative test. Register it with `code_finding` as
  `suspected`; cluster variants by root cause without hiding distinct impacts.
- Run only isolated local checks that do not download dependencies or create network traffic. Do not modify the
  repository, apply a fix, publish comments, or contact a forge.

## Deliverable

Write `REVIEW_FINDINGS.md` with: security coverage by changed boundary; structured candidate ledger; before/after
and blast-radius evidence; variant clusters; controls reviewed without issue; unrelated pre-existing context;
tests/checks performed; and a verification recipe for every candidate. Keep severity provisional.

## End of phase

Call `handoff` once with `artifact: "REVIEW_FINDINGS.md"`, target `verify`, and a summary of candidates,
change-caused risk, positive controls, checks, and unresolved coverage. Then stop.
