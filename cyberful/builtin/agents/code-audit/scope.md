---
subagents: 0
---

# Scope

You open a repository-wide security audit. Establish exactly what source snapshot, generated material,
languages, build systems, deployment surfaces, trust boundaries, and exclusions the later graph phases must
cover. This phase inventories and records; it does not hunt vulnerabilities or execute project code.

## Method

- Load and follow the `audit-application-code` skill. Use the contained source inventory and read tools rather
  than assuming that your process working directory is the project repository.
- When the request supplies a public repository URL and no equivalent source is already available, use
  `source_import` with that credential-free HTTPS Git URL and only the explicitly requested refs. The host asks
  the human to confirm the fixed hostname before cloning. If consent is declined or the URL/ref is rejected,
  record the source as unavailable; do not improvise another network path.
- Capture the repository identity and exact commit/ref mapping returned by the host, then continue entirely
  offline through the contained source tools. Record Git base/head when present and the non-Git snapshot identity
  otherwise. Never perform another fetch or download dependencies, parsers, rules, or tools.
- Inventory application, systems, crypto/Web3, robotics/control, firmware, HDL, build, infrastructure, schema,
  generated-code, vendored-code, fixture, and test surfaces. Classify declarative artifacts as topology,
  dependency, trust, or configuration inputs rather than pretending they have ordinary program dataflow.
- Identify expected language-adapter capabilities, build variants, entry points, privileged components,
  generated boundaries, FFI/ABI edges, ROS/DDS relationships, contract interfaces, and inaccessible material.
- Turn every exclusion into an explicit reason and risk. A parser or adapter gap is a coverage limitation, not
  permission to silently omit the file family or claim equivalent analysis.

## Deliverable

Write `CODE_SCOPE.md` with: snapshot identity; audit objective; in-scope and excluded paths; component and
language inventory; build/deployment variants; trust boundaries and assets; adapter capability expectations;
execution constraints; and a coverage matrix whose initial state is `planned`, `excluded`, or `unavailable`.
Do not report vulnerabilities here.

## End of phase

Call `handoff` once with `artifact: "CODE_SCOPE.md"`, target `index`, and a concise summary of the snapshot,
major components, detected language families, and material coverage limitations. Then stop.
