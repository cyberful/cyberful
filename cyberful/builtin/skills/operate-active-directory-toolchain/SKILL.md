---
name: operate-active-directory-toolchain
description: Operate Impacket, Certipy, BloodHound-compatible collection, Kerberos and LDAP tooling, SMB/RPC probes, and Metasploit modules for advanced Active Directory assessment. Use for identity and trust graph construction, AD CS analysis, delegation and Kerberos review, credential-path validation, collection-gap diagnosis, or converting graph edges into bounded, reproducible authority paths.
---

# Operate Active Directory Toolchain

Build an identity graph with provenance. A graph edge is a hypothesis until the principal, object, ACL or protocol condition, time, and resulting authority are validated against the directory or endpoint.

## Pin the domain tuple

Record forest/domain, DNS and NetBIOS names, domain SID, functional levels, domain controllers and sites, time offset, queried Global Catalog/DC, credential principal and logon type, network vantage, DNS resolver, and tool versions. Kerberos conclusions are invalid when name resolution or time is wrong.

## Collect by independent planes

Gather LDAP objects/ACLs, group membership including nesting and primary groups, trusts, GPO links and inheritance, SPNs, delegation attributes, AD CS configuration, DNS, SMB/RPC service evidence, and endpoint/local-group/session evidence where authorized. Track denied, partial, and stale collections separately.

Use BloodHound-style graphs for prioritization, not proof. Use Impacket/LDAP/RPC and Certipy to verify the exact relationship.

Read [references/ad-fieldbook.md](references/ad-fieldbook.md) for high-value paths and graph traps.

## Analyze credential and ticket provenance

For every hash, key, ticket, certificate, or token, record source, principal/SID, domain, type, acquisition time, validity, session context, and whether it has been tested. Distinguish password-derived material, NT hashes, AES keys, TGTs, service tickets, certificates, and machine credentials; each enables different protocols and leaves different evidence.

## Validate authority chains

Trace from a reachable principal through group expansion, ACL/control right, delegation or certificate issuance, service execution, local privilege, or trust transition to the target effect. Check deny ACEs, object-specific rights, inheritance, owner/write-DACL/write-owner paths, SID history, AdminSDHolder effects, and replication latency.

For AD CS, model enrollment rights, template flags, EKUs/application policies, subject/SAN construction, manager approval, authorized signatures, issuance requirements, CA policy, web enrollment/relay surface, mapping behavior, and certificate lifetime/revocation.

## Deliver

Preserve collection scope, query host/DC, raw object identifiers and ACLs, graph edge provenance, ticket/certificate metadata without secret material, bounded validation, collection gaps, and the minimal remediation edge that breaks each path. Avoid reporting an entire multi-hop path as demonstrated when only the first edge was checked.
