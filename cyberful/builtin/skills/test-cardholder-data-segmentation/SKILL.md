---
name: test-cardholder-data-segmentation
description: Test whether every segmentation and scope-reduction control isolates the cardholder data environment from claimed out-of-scope systems and differing security levels. Use for PCI DSS 11.4.5 or 11.4.6 segmentation validation after scoping or control changes.
metadata:
  domain: payment-security
  subdomain: cde-segmentation
  triggers:
    - test cardholder data segmentation
    - pci dss segmentation test
    - validate cde isolation
    - pci dss 11.4.5 testing
    - service provider segmentation testing
    - scope reduction control test
  tags:
    - pci-dss
    - cde
    - segmentation
    - isolation
    - scope-reduction
    - network-boundary
  frameworks:
    pci_dss:
      - 11.4.1
      - 11.4.5
      - 11.4.6
---

# Test Cardholder Data Segmentation

Test the claim that an out-of-scope component cannot communicate with or impact the security of the CDE even if that component is compromised. A diagram, denied ping, firewall rule, or absence of an observed route is not sufficient by itself.

## Establish the tested claims

Read [references/segmentation-test-method.md](references/segmentation-test-method.md). Begin with the CDE trace, every environment claimed out of scope, every segmentation method in use, differing security levels, third-party and administrative paths, and changes since the last validation.

Use [assets/segmentation-test-matrix.template.json](assets/segmentation-test-matrix.template.json) under [assets/segmentation-test-matrix.schema.json](assets/segmentation-test-matrix.schema.json). Each case must name its authorized source vantage, protected destination or capability, isolation method, expected denial invariant, protocol family, evidence, and sampling rationale.

## Exercise each unique isolation mechanism

Test from representative out-of-scope networks and systems toward the CDE, not only from the CDE outward. Include permitted intermediaries, shared control planes, identity and management services, name resolution, proxies, load balancers, routing, wireless, remote access, cloud security groups, service meshes, Kubernetes policies, virtualization boundaries, and failover paths where they participate in isolation.

Change one dimension at a time. Distinguish no route, active rejection, application denial, authenticated administrative reach, and an inconclusive timeout. Confirm that alternate protocols, addressing forms, ports, paths, identities, and asynchronous mechanisms do not bypass the intended control.

Use only authorized, bounded Cyberful network and application tools. In Code Audit, inspect policy and construct loopback or disposable-lab cases; do not contact an external target. Do not expand scope or increase effects merely because the test is labeled PCI DSS.

## Interpret and route outcomes

If an out-of-scope system reaches or can impact the CDE, preserve the shortest supported path and notify the engagement owner because the PCI DSS scope claim may change. Do not access account data to prove reachability. Route application authorization gaps to `test-authorization-boundaries`, network enumeration to `operate-network-recon`, and updated boundaries back to `trace-cardholder-data-environment`.

Record supported isolation, contradicted isolation, untested mechanism, and evidence gap separately. A technical result supports assessment evidence but does not itself issue a PCI DSS compliance verdict.

## Authoritative anchors

- PCI DSS v4.0.1: https://docs-prv.pcisecuritystandards.org/PCI%20DSS/Standard/PCI-DSS-v4_0_1.pdf
- PCI SSC Penetration Testing Guidance v1.1: https://www.pcisecuritystandards.org/documents/Penetration-Testing-Guidance-v1_1.pdf
