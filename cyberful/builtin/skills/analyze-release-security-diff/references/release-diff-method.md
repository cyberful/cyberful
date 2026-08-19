# Release Diff Method

## Manifest contract

Each artifact needs a stable logical path, content digest, source revision, provenance digest, signer identity, deployment permissions, and dependency identities. Record unknown values explicitly during collection; do not substitute names or mutable tags for identities.

## Interpret changes

- A content change with unchanged provenance can still be expected; verify the build subject and source revision.
- A signer change requires trust-root and rotation evidence.
- Permission additions identify a changed deployment authority, not automatically an exploitable path.
- Dependency additions or digest changes require reachability and loader evidence.
- A removed artifact can reflect cleanup, packaging drift, or incomplete collection.

The diff selects evidence for pipeline review. It does not attest artifacts, retrieve dependencies, or decide whether a release is safe.
