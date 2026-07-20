---
subagents: 3
---

# Trace

Use the validated graph to map security-sensitive reachability and test the system's claimed control model
before broad vulnerability hunting. Establish how untrusted or low-trust influence reaches assets,
interpreters, privilege changes, cryptographic operations, actuators, firmware/hardware boundaries, and
build or release authority.

## Method

- Read `CODE_SCOPE.md` and `CODE_GRAPH.md`; load `operate-code-graph`, `threat-model-application`, and the
  narrowest relevant tracing skills.
- Convert each material threat and unacceptable outcome into a concrete source, sink, control owner, negative
  test, and residual uncertainty. Build identity/role/tenant and resource/action matrices where applicable.
- Start from entry points and trust boundaries, then query both forward from sources and backward from sinks.
  Use bounded taint, slicing, neighbors, and path queries; preserve `truncated` and coverage fields.
- Analyze guard dominance, default-deny behavior, revocation, auditability, middleware and authorization coverage, aliases, callbacks, dynamic dispatch,
  summaries, storage/retrieval, async jobs, generated clients, FFI, ABI, topic/service, signal/register, and
  configuration-mediated edges.
- Trace dependencies and automation from contributor-controlled input through resolution, lifecycle scripts,
  runners, caches, artifacts, signing, promotion, deployment, and runtime identity. Verify authority and byte
  continuity at every transition.
- Cover application, native-memory, cryptographic, smart-contract, agentic-AI, robotics/firmware, build/release, and
  infrastructure paths that exist in scope. For HDL, PLC, and assembly, reason in the adapter's domain model
  rather than inventing function-level semantics.
- Treat paths as hypotheses until code and contextual evidence establish their meaning. Do not record a
  confirmed finding merely because a graph path exists.

## Deliverable

Write `CODE_TRACE.md` with: threat and control matrix; assets and unacceptable outcomes; identity/tenant matrix;
source/sink/guard inventory; trust-boundary and privilege paths; security-critical backward slices;
cross-language and producer-to-runtime traces; controls that dominate examined paths; suspected bypass routes;
negative tests; query limits; and ranked targets for `hunt`.
Use stable graph node or path identifiers wherever the host provides them.

## End of phase

Call `handoff` once with `artifact: "CODE_TRACE.md"`, target `hunt`, and a summary of the highest-risk
reachable paths, dominant controls, and analysis limits. Then stop.
