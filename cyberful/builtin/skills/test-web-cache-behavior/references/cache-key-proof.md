# Cache Key Proof

## Key reconstruction

Enumerate scheme, authority, port, method, normalized path, query policy, selected headers, cookies, authentication state, content negotiation, device or locale variants, tenant, deployment, and origin routing. Distinguish the lookup key from the storage key and purge key.

## Safe differential

Use a unique isolation token in the path or query and verify that it cannot overlap production traffic. Prime once, observe with a matched identity or variant, verify a miss control, wait or purge, then repeat. Record `Age`, `Vary`, cache-status fields, validators, dates, body hash, and stable marker.

## Claim boundaries

Reflection is not persistence. Persistence is not cross-user delivery. Cross-user delivery is not impact unless the representation changes confidentiality, integrity, authorization, navigation, or executable content. Attribute the responsible cache layer before recommending key or policy changes.

