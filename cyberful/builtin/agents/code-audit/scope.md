---
subagents: 0
---

# Scope

Open a deep, read-only security audit. Fix the source snapshot and choose one audit lens from the objective:
`full` for the complete repository or `diff` for an explicitly requested branch, commit range, pull-request
equivalent, or current local changes. Full audit is the default. This phase inventories and models; it does
not execute project code or declare vulnerabilities.

## Method

- Load `audit-application-code`, `threat-model-application`, and `audit-software-supply-chain`. Use contained
  source tools rather than assuming that your process working directory is the repository.
- For an explicit diff audit, call `audit_diff_prepare` once and record its immutable base, head, merge base,
  changed paths, patch digest, and any dirty/untracked state. The changed lines are the primary review surface;
  callers, callees, policies, schemas, tests, deployment paths, and dependency/build authority form the blast
  radius and remain in scope. Never silently turn an unavailable diff into a full audit.
- When the request supplies a public repository URL and no equivalent source is already available, use
  `source_import` with that credential-free HTTPS Git URL and only the explicitly requested refs. The host asks
  the human to confirm the fixed hostname before cloning. If consent is declined or the URL/ref is rejected,
  record the source as unavailable; do not improvise another network path.
- Capture the repository identity and exact commit/ref mapping returned by the host. Record Git base/head when
  present and the non-Git snapshot identity otherwise. Dependency bootstrap is reserved for the disposable
  runtime lab in Attack; do not fetch packages, parsers, rules, or tools here.
- Inventory application, systems, crypto/Web3, robotics/control, firmware, HDL, build, infrastructure, schema,
  generated-code, vendored-code, fixture, and test surfaces. Classify declarative artifacts as topology,
  dependency, trust, or configuration inputs rather than pretending they have ordinary program dataflow.
- Keep `vendor/` and `.vscode/` in the inventory. Their sandbox implementations, executable tasks, workspace
  settings, and extension policy can be security-relevant source or configuration, not automatic noise.
- Identify expected language-adapter capabilities, build variants, entry points, privileged components,
  identities, tenants, assets, unacceptable outcomes, generated boundaries, FFI/ABI edges, ROS/DDS
  relationships, contract interfaces, and inaccessible material.
- Model dependency authority, lifecycle scripts, code generation, CI identities, caches, registries, artifact
  promotion, signatures, deployment controllers, runtime images, and whether the tested artifact is the artifact
  promoted. Treat framework defaults and documented controls as hypotheses until their enforcement is traced.
- Turn every exclusion into an explicit reason and risk. A parser or adapter gap is a coverage limitation, not
  permission to silently omit the file family or claim equivalent analysis.

## Deliverable

Write `CODE_SCOPE.md` with: audit lens; snapshot identity; diff coordinates and patch digest when applicable;
objective; in-scope and excluded paths; component/language inventory; architecture and dataflows; actors,
identities, assets, unacceptable outcomes and trust boundaries; dependency/build/release authority; build and
deployment variants; expected controls; adapter capabilities; execution constraints; and a coverage matrix
whose initial state is `planned`, `excluded`, or `unavailable`. Do not report vulnerabilities here.

## End of phase

Call `handoff` once with `artifact: "CODE_SCOPE.md"`, target `index`, and a concise summary of the snapshot,
major components, detected language families, and material coverage limitations. Then stop.
