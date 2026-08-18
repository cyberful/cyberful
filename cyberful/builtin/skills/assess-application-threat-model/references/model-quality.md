# Threat Model Quality Gate

Reject or revise the model when:

- diagrams omit protocols, identities, data sensitivity, direction, or trust boundaries;
- the deployed architecture differs from the modeled architecture without an explicit overlay;
- external services are represented as uniformly trusted boxes;
- only the happy path is modeled;
- threats are generic labels without preconditions, paths, assets, or outcomes;
- controls have no owner, placement, failure behavior, or verification method;
- authorization is modeled only as roles rather than actor-resource-action-state decisions;
- business invariants, asynchronous processing, retries, revocation, recovery, and administrative workflows are absent;
- build, CI/CD, deployment, cloud identity, and third-party code are outside the model without justification;
- agent tools or autonomous actions are modeled as ordinary text generation;
- privacy and sensitive-data copies are reduced to database encryption;
- residual risk is silently converted into acceptance.

Use challenge questions:

1. Which single assumption creates the largest blast radius if false?
2. Where is authority created or amplified?
3. Which component trusts a decision made elsewhere?
4. Which state transition moves money, privilege, identity, or sensitive data?
5. What happens when messages duplicate, reorder, delay, or partially fail?
6. Which parser or intermediary sees a different representation?
7. Which non-production, support, migration, or recovery path has production trust?
8. Which security dependency can fail open?
9. Can monitoring distinguish legitimate administration from compromise?
10. What evidence would prove each critical control actually works?
