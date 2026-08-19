# Release integrity method

## Trace one artifact identity

Bind the commit digest, build definition digest, dependency lock state, builder identity, artifact digest, provenance envelope, signature, repository coordinates, promotion record, deployment manifest, target environment, and resulting release identity. A tag, filename, branch, or human-readable version is not a stable artifact identity.

## Boundary checks

- Source: protected changes, reusable workflow pinning, generated input ownership, and review bypasses.
- Build: ephemeral or persistent runner trust, untrusted code boundaries, secret timing, network assumptions, and cache poisoning.
- Artifact: immutable digest addressing, write/read separation, retention, provenance, signing, and verification policy.
- Promotion: environment separation, approver independence, policy evaluation, and prevention of artifact substitution.
- Deployment: workload identity audience, target binding, least privilege, change reconciliation, and audit evidence.
- Rollback: allowed artifact set, emergency identity, review after use, and prevention of unsigned or stale rollback artifacts.

Grade each boundary as enforced, advisory, bypassable, unknown, or not applicable and attach the source artifact that supports the grade.
