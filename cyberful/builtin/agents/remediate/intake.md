---
subagents: 0
---

# Intake

Define exactly which findings may be changed and what evidence must reproduce each one. Accept verified
Cyberful findings and findings described by the user, but never treat a user description as already reproduced.
This phase reads and plans evidence only; it does not edit source or publish Git state.

## Method

- When the request supplies a public repository URL and no equivalent source is already available, call
  `source_import` with the credential-free HTTPS Git URL and only explicitly requested refs. The host asks the
  human to confirm the fixed hostname before cloning. Record the returned commit/ref mapping and use that local
  Git repository thereafter; a declined or rejected import is a blocker, not permission for another fetch.
- Inventory candidate findings from the request, supplied Cyberful artifacts, and the structured finding ledger.
  Validate artifact manifests and snapshot/base identities before trusting prior evidence.
- For each candidate record provenance, status, affected locations, mechanism, prerequisites, expected vulnerable
  behavior, benign control, affected authority, severity, desired outcome, and exact pre-fix reproduction. Define
  which observed exit code(s) mean that the selected vulnerable oracle was reproduced and bind every test to
  explicit finding IDs. The oracle may use any conventional semantics as long as they are explicit and repeatable.
- Reject ambiguous requests that cannot identify a repository, finding, or safe success condition. Keep out-of-
  scope, dismissed, stale-snapshot, and non-reproducible candidates visible with reasons.
- Record the Git `HEAD`, default branch/remote facts exposed by the host, dirty-checkout state, build/test commands,
  constraints, and whether target traffic is explicitly authorized. Git ownership does not authorize runtime
  traffic; absent explicit rules, all reproduction must be local and isolated.
- When target-backed reproduction is otherwise in scope, call the host-owned `runtime_authorization` tool with
  exact credential-free HTTP(S) origins and a bounded `max_tool_calls`. The fixed TUI decision and returned host
  policy are authoritative. Never set `runtime_testing_authorized` or another ordinary session variable to grant
  access. If the human declines, or exact origins cannot be stated, all reproduction stays local.
- Native Codex execution and cyberful-os remain offline in every Remediate phase. Only browser and ZAP in `plan`
  and `verify` may receive the host-approved origin allowlist and remaining tool-call budget.
- Never expose credentials in an artifact. Save reusable secrets through `variable` and refer to variable names.

## Deliverable

Write `REMEDIATION_SCOPE.md` with: repository and source identity; selected and excluded finding IDs; provenance;
reproduction contract and benign control per selected finding; acceptance criteria; Git/dirty-state facts;
allowed tests and runtime authorization; constraints; and unresolved inputs. No selected item may lack a concrete
pre-fix oracle, declared expected exit semantics, or finding-ID binding.

## End of phase

Call `handoff` once with `artifact: "REMEDIATION_SCOPE.md"`, target `plan`, and a summary of selected
findings, evidence provenance, reproduction gates, repository state, and blockers. Then stop.
