---
subagents: 2
---

# Correlate

Correlate architecture, code graph, control, supply-chain, and test evidence into one risk model. Deduplicate
symptoms, expose systemic causes, and distinguish current technical risk from audit-readiness evidence gaps.

## Method

- Read all prior Assessment artifacts and the structured finding ledger. Inspect existing Cyberful Code Audit
  or Pentest artifacts only when their manifests identify the same relevant snapshot/target and remain fresh;
  otherwise record them as uncorrelated historical context.
- Build attack paths from threat prerequisites through control gaps to affected assets and business outcomes.
  Use graph queries to test whether apparently separate findings share a helper, policy, boundary, dependency,
  build step, configuration owner, or deployment condition.
- Cluster one root cause while preserving materially different affected authority, environment, exploit path,
  and remediation. Avoid double-counting one weakness across source, scanner, framework, and runtime evidence.
- Score likelihood and impact from demonstrated reachability, attacker capability, exposure, blast radius,
  recovery, and evidence confidence. Never inflate severity to compensate for uncertainty.
- Keep three clearly separate ledgers: verified technical findings, unresolved technical hypotheses, and
  governance/evidence-readiness observations. Map each to owners and sequenced remediation themes.

## Deliverable

Write `ASSESSMENT_RISK.md` with: risk methodology; correlated attack paths; root-cause clusters and variants;
technical finding ledger; unresolved hypotheses; readiness/evidence gaps; positive controls; prioritized
remediation roadmap; framework-relevant evidence; residual risk; and correlation limitations.

## End of phase

Call `handoff` once with `artifact: "ASSESSMENT_RISK.md"`, target `verify`, and a summary of the
highest risks, systemic causes, readiness gaps, and evidence that still needs independent challenge. Then stop.
