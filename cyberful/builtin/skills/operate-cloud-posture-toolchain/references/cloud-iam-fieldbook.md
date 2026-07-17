# Cloud IAM Fieldbook

## Effective-access lattice

Evaluate authorization as an intersection/union appropriate to the provider:

- identity and group/role grants;
- resource-based grants;
- role or workload trust;
- session and federation claims;
- permission boundaries;
- organization/management-group constraints;
- key, bucket, queue, registry, and secret policies;
- service-specific grants or ACLs;
- conditions involving tags, paths, source resources, networks, time, MFA, or external IDs.

An allow in one document can be neutralized or amplified elsewhere. Preserve the request context needed to evaluate conditions.

## AWS escalation motifs

- create/update function or task plus pass role;
- modify role trust then assume it;
- attach inline/managed policy or add principal to privileged group;
- launch template, instance profile, SSM, build, pipeline, or deployment mutation;
- KMS key-policy/grant control paired with ciphertext access;
- read secret plus invoke workload that exposes or uses it;
- resource-policy injection for bucket, queue, topic, registry, function, or secret;
- CloudFormation or service catalog execution under a stronger role;
- OIDC claim looseness or confused-deputy trust without audience/external-source constraints.

## Cross-cloud patterns

- workload identity subject pattern broader than intended repository/namespace/service account;
- CI federation accepting pull-request or fork-controlled claims;
- management-plane role allows changing data-plane authorization;
- logging destination writable or deletable by the monitored workload;
- break-glass identity continuously usable without independent control;
- service account key or application credential bypasses conditional access;
- public endpoint combined with identity-aware proxy bypass path.

## False-negative traps

Unqueried regions, pagination loss, delegated accounts, conditional API denial, resource policies, inherited grants, newly created services, organization policy outside account view, stale credential sessions, provider aliases, and scanner checks that treat API error as skip.

## Proof standard

Prefer policy simulation plus read-only identity/resource evidence. If a state change is required to validate a chain, define the minimal reversible step and its blast radius before execution; otherwise report the chain as supported rather than demonstrated.
