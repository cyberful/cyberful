# ATT&CK applicability and review

## Applicability decision

Choose `APPLICABLE` only when observed or credibly hypothesized adversary behavior matches an ATT&CK object in the embedded snapshot. Preserve the exact object returned by `get`, the domain, why its semantics match, and the primary evidence references. A target product, vulnerability class, or impact label alone is insufficient.

Choose `NOT_APPLICABLE` when ATT&CK does not add an honest behavioral description. This is a neutral classification, not a negative finding signal. Standalone implementation defects, novel primitives, business-logic invariants, IDOR root causes, parser bugs, and zero-days can be important or critical without an ATT&CK mapping.

Choose `UNAVAILABLE` only when the embedded dataset cannot be queried or verified. Continue the authorized investigation without inventing ATT&CK facts from memory.

## Discovery remains open-ended

Do not derive test coverage solely from the ATT&CK matrix. Start from assets, trust boundaries, identities, state machines, invariants, parsers, data flows, protocol edges, implementation behavior, and attacker creativity. Search explicitly for mechanisms and chains that ATT&CK does not yet describe. Treat ATT&CK coverage and vulnerability coverage as independent dimensions.

## Review

Only Verify assigns the final review. `ACCEPTED` keeps the proposed mappings, `REVISED` records corrected mappings and rationale, and `REJECTED` removes unsupported ATT&CK context. Review the mapping and vulnerability verdict independently: either may survive when the other does not.
