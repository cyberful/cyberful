---
name: operate-network-recon
description: Build a high-fidelity network and service inventory using Nmap, Masscan, packet capture, DNS, and protocol-specific follow-up. Use for authorized external or internal reconnaissance, service fingerprinting, exposure validation, segmentation checks, UDP discovery, TLS/SNI routing, scan reconciliation, or when an existing port list may be incomplete or misleading.
---

# Operate Network Recon

Separate host reachability, port state, service identity, application identity, and vulnerability hypotheses. Each requires different evidence.

## Establish the scan contract

Record target set, exclusions, vantage point, address family, DNS resolution time, allowed rates, maintenance constraints, credential availability, expected intermediaries, and whether UDP or non-default protocols are required.

Create a target ledger before scanning. Expand CIDRs and hostnames deliberately; preserve original hostname-to-address mappings and do not silently merge multiple virtual services behind one IP.

## Layer discovery

1. **Route and name:** DNS records, reverse DNS, ASN/network ownership, local routes, proxy/VPN path.
2. **Reachability:** multiple host discovery probes or -Pn when filtering makes ICMP conclusions unreliable.
3. **Port inventory:** full or justified range with explicit timing/rate.
4. **Service identity:** targeted -sV on discovered ports with adequate version intensity.
5. **Protocol confirmation:** native client or NSE script selected for that protocol.
6. **Application routing:** SNI, Host, protocol upgrade, realm, tenant, or virtual-service distinctions.
7. **Security checks:** narrow scripts or manual probes driven by confirmed service features.

Read [references/service-fingerprint-fieldbook.md](references/service-fingerprint-fieldbook.md) for false-negative and cross-protocol heuristics.

## Use Nmap output as evidence

Always persist normal, XML, and grepable outputs when practical. Include exact target input, command, Nmap version, timestamps, elapsed time, and scan conditions. Prefer XML for machine correlation.

Treat states precisely:

- open: a service accepted/responded;
- closed: target reachable and rejected at that instant;
- filtered: probes lacked a decisive response;
- open|filtered: common UDP ambiguity;
- unfiltered: reachable but open/closed unresolved.

Do not translate filtered into closed or host down.

## Reconcile scanners

Masscan is a fast candidate generator; Nmap and protocol clients are validators. Differences can arise from rate, retries, source port, SYN proxying, load balancing, ephemeral services, tarpits, anycast, or per-source policy.

For every material discrepancy:

1. rescan serially from the same vantage;
2. capture packets if possible;
3. vary only one transport assumption;
4. validate with the native protocol;
5. timestamp the conclusion.

## Select scripts narrowly

Choose NSE categories/scripts from a concrete hypothesis. Inspect script arguments and source for authentication, broadcast behavior, brute force, intrusive actions, or dependency assumptions. Prefer explicit script names over broad categories, and preserve script output separately from version detection.

## Handoff

Produce:

- live/unknown host ledger;
- port/service/application matrix;
- hostname/SNI/vhost mappings;
- protocol features and authentication surfaces;
- conflicting or unstable observations;
- coverage gaps by address family, transport, port range, and vantage;
- prioritized hypotheses with the exact next discriminator.
