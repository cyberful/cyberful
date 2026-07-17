---
subagents: 3
---

# Trace

Use the validated graph to map security-sensitive reachability before broad vulnerability hunting. Establish
how untrusted or low-trust influence reaches assets, interpreters, privilege changes, cryptographic operations,
actuators, firmware/hardware boundaries, and release authority.

## Method

- Read `CODE_SCOPE.md` and `CODE_GRAPH.md`; load `operate-code-graph`, `threat-model-application`, and the
  narrowest relevant tracing skills.
- Start from entry points and trust boundaries, then query both forward from sources and backward from sinks.
  Use bounded taint, slicing, neighbors, and path queries; preserve `truncated` and coverage fields.
- Analyze guard dominance, middleware and authorization coverage, aliases, callbacks, dynamic dispatch,
  summaries, storage/retrieval, async jobs, generated clients, FFI, ABI, topic/service, signal/register, and
  configuration-mediated edges.
- Cover application, native-memory, cryptographic, smart-contract, robotics/firmware, build/release, and
  infrastructure paths that exist in scope. For HDL, PLC, and assembly, reason in the adapter's domain model
  rather than inventing function-level semantics.
- Treat paths as hypotheses until code and contextual evidence establish their meaning. Do not record a
  confirmed finding merely because a graph path exists.

## Deliverable

Write `CODE_TRACE.md` with: assets and unacceptable outcomes; source/sink/guard inventory; trust-boundary and
privilege paths; security-critical backward slices; cross-language traces; controls that dominate examined
paths; suspected bypass routes; query limits; and the ranked trace targets that `hunt` must investigate.
Use stable graph node or path identifiers wherever the host provides them.

## End of phase

Call `handoff` once with `artifact: "CODE_TRACE.md"`, target `hunt`, and a summary of the highest-risk
reachable paths, dominant controls, and analysis limits. Then stop.
