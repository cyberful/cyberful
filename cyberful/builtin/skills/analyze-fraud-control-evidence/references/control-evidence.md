# Fraud Control Evidence

## Evidence hierarchy

Prefer the policy engine decision with version and reason codes, the enforcement record that consumed it, and the authoritative business-state or ledger effect. UI messages, client responses, dashboards, and analyst notes are supporting evidence unless they are the system of record.

## Comparison dimensions

Hold the scenario and control constant before comparing channel, identity state, device state, policy version, signal freshness, value band, beneficiary age, velocity window, or experiment cohort. When several dimensions change, retain the observation but do not attribute the outcome to one control.

## Decision semantics

Normalize only the broad decision class: allow, challenge, deny, review, error, or not-applicable. Preserve native reason codes and references rather than translating them into invented semantics. Distinguish a control decision from downstream enforcement and from the final durable effect.

## Conflict interpretation

Conflicting decisions may reflect drift, stale inputs, cohorting, fallback, manual override, or a legitimate policy difference. Verify timestamps, policy versions, control ownership, and effect records before treating the conflict as a control failure.

## Data handling

Use synthetic or pseudonymous actor labels. Do not copy credentials, full payment instrument data, regulated identifiers, free-form case notes, or raw customer payloads into the ledger. Point to access-controlled evidence instead.
