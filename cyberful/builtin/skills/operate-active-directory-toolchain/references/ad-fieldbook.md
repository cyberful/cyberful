# Active Directory Fieldbook

## High-value path motifs

- write owner or DACL leading to a more direct control right;
- group membership control through nested or foreign-security principals;
- resource-based or constrained delegation with a usable service/protocol path;
- unconstrained delegation or privileged authentication reaching an exposed host;
- certificate template enrollment plus subject, EKU, mapping, or issuance weakness;
- GPO creation/link/edit rights reaching computers or users in scope;
- machine-account or quota paths combined with delegation or certificate behavior;
- DNS record control steering privileged authentication or service discovery;
- local admin/session edge that is stale in the graph but valid on a subset of hosts;
- trust direction/filtering/SID-history conditions enabling a forest or domain transition.

## Graph traps

- ACL collected from the Global Catalog lacks attributes available on a writable DC;
- token group expansion differs due to SID history, primary group, domain-local scope, or selective authentication;
- AdminSDHolder protected objects do not inherit as expected;
- an SPN edge exists but the service account password/crypto posture or service reachability changes usefulness;
- session data is ephemeral and often stale;
- local admin inferred from GPO may not match live policy application;
- certificate template looks exploitable but CA issuance policy or mapping blocks the path;
- delegation attributes exist but target service, protocol transition, or account sensitivity changes the result.

## AD CS decision record

Capture template and CA object GUIDs, security descriptor, enrollment permissions, subject-name flags, EKUs/application policies, schema version, authorized signatures, manager approval, validity, renewal, private-key export, issuance policy, CA edit flags, web/RPC enrollment endpoints, and principal mapping mode. Validate certificate authentication separately from certificate issuance.

## Kerberos diagnostics

Check canonical SPN, realm, DC time, encryption types, pre-authentication, account flags, PAC behavior, referrals, trust keys, and ticket cache. NTLM fallback can make a broken Kerberos path look successful; preserve negotiated protocol.

## False-negative traps

DNS/site routing, read-only DCs, replication delay, LDAP signing/channel binding, selective authentication, protected users, gMSA permissions, cross-domain groups, primary-group membership, hidden certificate services, endpoint firewalling, stale sessions, and collection credentials unable to read security descriptors.
