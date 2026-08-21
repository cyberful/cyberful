---
name: test-identity-linking-provisioning
description: Test identity linking, invitation, merge, provisioning, deprovisioning, and account-association ceremonies for proof-of-control, tenant binding, uniqueness, lifecycle, and rollback failures using tester-owned identities.
metadata:
  domain: identity-security
  subdomain: identity-linking-provisioning
  triggers:
    - test account linking
    - identity merge security
    - SCIM provisioning assessment
    - invitation tenant binding
    - deprovisioning access test
  tags:
    - identity-linking
    - provisioning
    - SCIM
    - invitations
    - account-merge
    - lifecycle
  frameworks:
    mitre_attack:
      - T1098
    nist_csf:
      - PR.AA-01
      - PR.AA-03
      - PR.AA-05
    mitre_f3:
      - F1005.001
---

# Test Identity Linking and Provisioning

Treat each association as an authority transition between independently identified principals. Test only identities and tenants supplied for the engagement; never invite, merge, disable, or deprovision an unrelated account.

Copy [identity-linking-ledger.template.json](assets/identity-linking-ledger.template.json) into the workarea and read [identity-linking-method.md](references/identity-linking-method.md) before exercising a state-changing ceremony.

## Build the ceremony graph

Record initiator, target identity, verified channels, issuer and subject identifiers, tenant, current memberships, intended post-state, token freshness, approval owner, rollback, notification, and audit evidence. Cover create, invite, accept, link, unlink, merge, provision, update, suspend, reactivate, and deprovision only where each transition is explicitly authorized.

## Test one invariant at a time

Compare matched transitions for stale invitations, identifier reuse, email canonicalization, issuer confusion, pre-existing sessions, role carryover, cross-tenant association, re-provisioning, partial failure, retry, and deprovision delay. Confirm durable state and session/access consequences rather than trusting response text.

Report the minimal transition that violates proof-of-control, uniqueness, tenant, authorization, or lifecycle invariants, plus cleanup and residual access. Route federation token semantics to `test-federated-identity` and recovery proofing to `test-account-recovery-assurance`.
