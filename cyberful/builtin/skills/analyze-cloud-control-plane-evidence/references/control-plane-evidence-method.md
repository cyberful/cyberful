# Control-Plane Evidence Method

## Normalize collection

Use the same resource identity and field semantics across snapshots. Record provider, account or project, region, capture time, collector and scope. Represent unobserved fields explicitly in collection notes rather than converting them to secure defaults.

## Interpret drift

- Added and removed resources require lifecycle or collection evidence before a security conclusion.
- Principal changes require canonical principal identities and policy-source attribution.
- Public, encryption, logging, and lifecycle changes are observations, not vulnerability verdicts.
- A policy digest change requires the underlying policy artifact to explain which authority changed.

Use the ledger to select a focused IAM, infrastructure, secret, serverless, container, or network review.
