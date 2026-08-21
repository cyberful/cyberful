# Identity propagation method

Use this reference when identity context crosses a gateway, token service, service hop, queue, cache, job, or persistence boundary.

## Event tuple

For each event record:

`order | component | artifact kind | issuer | subject | actor | client | tenant | audiences | scopes | assurance | credential hash | evidence SHA-256`

Never store a bearer token, session cookie, private key, client secret, or reusable assertion. Hash a stable credential identifier only when correlation is necessary and permitted.

## Boundary questions

- Which component authenticated the actor, and which component assigned the subject?
- Is the original actor retained when a broker or workload acts on behalf of a user?
- Is audience narrowed for the next hop, or can a token issued for one consumer be replayed to another?
- Are scopes or roles copied, recomputed from authoritative state, intersected, or widened?
- Is authentication context preserved accurately through exchange and session issuance?
- Does asynchronous work retain a bounded initiating identity and authorization freshness rule?
- Can caches correlate decisions by an incomplete identity tuple?
- Are issuer and subject interpreted in a namespace that prevents collision across identity providers?

## Causal standard

Correlate by explicit trace, request, message, job, session, or credential identifiers; use timestamps only as supporting evidence. A field delta locates a transformation but is not a security finding. Confirm the receiving trust contract and resulting security decision before assigning impact.
