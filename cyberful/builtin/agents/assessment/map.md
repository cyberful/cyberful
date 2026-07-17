---
subagents: 2
---

# Map

Build the evidence-backed system, deployment, supply-chain, and trust map that the control and testing phases
will assess. Use the Code Graph as one evidence source within the whole project model.

## Method

- Read `ASSESSMENT_MISSION.md`; load `operate-code-graph`, `threat-model-application`,
  `audit-application-code`, and `audit-software-supply-chain`.
- Inventory and index every in-scope source, configuration, infrastructure, build, CI/CD, dependency,
  container, schema, firmware, contract, robotics/control, and deployment artifact. Preserve graph coverage,
  parser/adapter gaps, unresolved edges, and excluded material.
- Model actors, human and machine identities, roles, tenants, processes, stores, queues/topics, external
  services, build/release authority, trust and privilege boundaries, sensitive data copies, lifecycle states,
  recovery paths, and unacceptable outcomes.
- Connect code to deployment using API/schema, FFI/ABI, generated-code, package, image, CI, cloud, ROS/DDS,
  signal/register, firmware, and configuration edges. Distinguish intended architecture from what artifacts
  actually deploy.
- Do not send target traffic. Runtime observations belong to `test` and only when the mission says
  they are authorized.

## Deliverable

Write `ASSESSMENT_MAP.md` with: snapshot and graph identity; component/deployment inventory; language and
artifact coverage; actors and assets; dataflow and trust-boundary map; identity/authorization model;
supply-chain/release path; runtime topology; security invariants and threat hypotheses; evidence references;
and all mapping limitations.

## End of phase

Call `handoff` once with `artifact: "ASSESSMENT_MAP.md"`, target `controls`, and a summary of the
system model, crown-jewel assets, highest-risk boundaries, and missing architecture evidence. Then stop.
