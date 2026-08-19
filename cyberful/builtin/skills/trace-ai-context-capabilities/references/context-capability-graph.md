# Context-Capability Graph

Use typed edges: `contains`, `retrieved_from`, `derived_from`, `selected`, `requested`, `canonicalized_to`, `approved`, `executed_as`, `returned_to`, `persisted_as`, `delegated_to`, and `fell_back_to`.

A missing parent is not a causal node: preserve it as a typed `missing-parent` evidence gap and omit the unsupported edge. Parent identifiers within one event must be unique; self-edges and cycles are invalid because they cannot describe a causal ordering. Keep model choice, deterministic policy decision, credential selection, canonical action, and external effect as separate nodes.
