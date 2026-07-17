---
subagents: 0
---

# Brief

Define the authoritative contract for a whole-project security assessment. Separate repository access from
authorization to send traffic: source access never implies permission to test a deployed target.

## Method

- Read the request and available engagement material. Load `audit-application-code` and
  `threat-model-application` to frame the evidence needed, but do not analyze controls or vulnerabilities yet.
- When the request supplies a public repository URL and no equivalent source is already available, call
  `source_import` with the credential-free HTTPS Git URL and only explicitly requested refs. The host asks the
  human to confirm the fixed hostname before cloning. Record the returned commit/ref mapping; after that one
  import, all source inspection and Code Graph work is offline. A declined or rejected import remains an explicit
  evidence gap rather than permission to use another network path.
- Fix the source snapshot, assessed products/environments, components, languages, deployment variants,
  sensitive assets, organizations, evidence period when supplied, and explicit exclusions.
- Record whether runtime testing is `authorized` or `not_authorized`. Mark it authorized only when the request
  or supplied rules of engagement identify concrete in-scope targets and permit active testing. Repository
  ownership, a URL in documentation, or general assessment intent is not sufficient.
- When runtime testing is otherwise in scope, call the host-owned `runtime_authorization` tool with the exact
  credential-free HTTP(S) origins and a bounded `max_tool_calls`. The fixed TUI decision and returned host policy
  are authoritative. Never set `runtime_testing_authorized` or another ordinary session variable to grant
  access. If the human declines, or exact origins cannot be stated, record runtime testing as `not_authorized`.
- Native Codex execution and cyberful-os remain offline in every Assessment phase. Only the browser and ZAP routes
  in `test` may receive the host-approved origin allowlist and remaining tool-call budget.
- When runtime testing is authorized, record exact targets, identity boundaries, prohibited effects, rate/time
  limits, production safeguards, and stop conditions. Store secret values through `variable`; document only
  their purpose and variable names.
- Record requested readiness lenses: OWASP ASVS, NIST SSDF, ISO/IEC 27001:2022, and SOC 2. These are evidence
  mappings only; Cyberful does not certify compliance or control operating effectiveness.

## Deliverable

Write `ASSESSMENT_MISSION.md` with: objective; assessed snapshot and environments; in/out of scope; evidence
sources; assets and stakeholders when supplied; runtime authorization state and rules; assessment lenses;
constraints; assumptions; missing evidence; and decision criteria for completion. Preserve exact non-secret
target inputs needed for an authorized test.

## End of phase

Call `handoff` once with `artifact: "ASSESSMENT_MISSION.md"`, target `map`, and a summary of scope,
snapshot, runtime authorization state, requested frameworks, and material unknowns. Then stop.
