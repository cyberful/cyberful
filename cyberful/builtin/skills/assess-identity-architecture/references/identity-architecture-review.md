# Identity architecture review

Use this reference when the identity path spans multiple administrative domains, issuers, brokers, tenants, or relying parties.

## Trust record

For every edge capture:

`source authority | subject namespace | actor | credential or assertion | audience | relying party | tenant | assurance | freshness | revocation | enforcement owner | failure mode`

Treat issuer discovery, key distribution, metadata, directory synchronization, client registration, redirect ownership, token exchange, and support operations as trust edges rather than implementation detail.

## Review questions

- Which component is authoritative for subject identity, tenant membership, entitlements, assurance, and session revocation?
- Can the same external subject resolve to more than one internal account, or can two issuers collide in one namespace?
- Does a broker preserve original actor, delegation chain, authentication context, and audience, or replace them with an ambiguous service identity?
- Does every relying party validate the intended issuer, signature algorithm, key state, audience, client, token type, lifetime, and tenant binding?
- Can stale directory, cache, queue, or session state outlive removal, reassignment, suspension, or recovery?
- Does a component fail closed when metadata, policy, key, directory, or revocation dependencies are unavailable?
- Can administrators, support staff, or automation cross assurance or tenant boundaries without a separately recorded decision?

## Evidence classes

Prefer configuration, protocol captures, signed metadata, code paths, policy definitions, event records, and controlled denial tests. Label diagrams, interviews, and intended behavior as claims until corroborated. Record unknowns rather than inferring trust from component names.

## Outcome vocabulary

- **Established:** the trust edge and enforcement owner are supported by evidence.
- **Conditional:** the claim depends on an unverified component or operational process.
- **Contradicted:** observed behavior differs from the documented trust contract.
- **Unbounded:** failure of one component can confer authority outside its declared domain.

Route claim transformation to `trace-identity-propagation`, tenant selection to `trace-tenant-context-propagation`, machine identity to `test-service-workload-identity`, recovery to `test-account-recovery-assurance`, and policy placement to `audit-access-policy-enforcement`.
