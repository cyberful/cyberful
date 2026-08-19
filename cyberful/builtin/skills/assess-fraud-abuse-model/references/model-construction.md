# Fraud Model Construction

## Start from protected value

List monetary balances, credit, inventory, benefits, loyalty value, access, identity reputation, limits, guarantees, and operational capacity. Name the authoritative owner for each value and the record that proves a durable change.

## Separate actor from identity

Model the human or automated actor, the presented identity, controlled accounts, delegated relationships, device or session context, and any merchant, beneficiary, support, or insider role separately. A single actor may control several identities; a single identity may be usable through several channels.

## Build path edges

Represent each path edge as:

`pre-state | actor capability | action | control decision | state transition | durable effect | evidence source`

Branch when channels, policy engines, ledger owners, asynchronous consumers, or recovery procedures differ. Add compensations and reversals as explicit edges rather than assuming they restore the original state.

## Evaluate controls

For each control capture its owner, inputs, freshness, decision, reason codes, fail-open behavior, downstream enforcement, reviewer override, and evidence retention. Mark whether the control prevents an action, limits value, detects later, or only supports investigation.

## Use framework mappings carefully

Map a demonstrated behavior to MITRE F3 only after confirming the technique semantics in the pinned Cyberful framework source. Do not force product-specific abuse, control design, or analysis activity into an adversary-technique identifier. Keep the native path description as the primary record.

## Exit criteria

A high-priority path is ready for testing only when authorization, controlled actors, synthetic value, expected decisions, stop conditions, cleanup, and authoritative evidence are all explicit. Otherwise retain it as a hypothesis or planning gap.
