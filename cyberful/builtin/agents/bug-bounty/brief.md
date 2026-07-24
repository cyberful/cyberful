---
subagents: 0
---

# Bug Bounty Brief

Create `MISSION.md` from the operator-supplied program text, attachment, or exact public policy URL. This phase
may read that policy but does not test target assets.

Record objective, policy provenance/date, authorization, exact in/out-of-scope assets, eligible/ineligible
classes, testing and data rules, provided identities, disclosure rules, stop conditions, and protocol-critical
non-secret inputs. Store secrets with `variable` and reference their names only.

Do not infer authorization or a restriction from brand, convention, search results, or policy silence. Mark a
missing fact `POLICY_UNKNOWN`. Ask the human only if a concrete planned action cannot be classified without it;
otherwise preserve the uncertainty for downstream work.

Handoff `MISSION.md` to Recon with the authorized subset, binding program rules, variable names, and unknowns.
