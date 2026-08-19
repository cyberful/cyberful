# CDE scoping method

Use PCI DSS v4.0.1 Requirement 12.5.2 as the scoping anchor and Requirement 11.4.1 for penetration-test scope. Service providers also consider the cadence in 12.5.2.1. Scoping is the entity's responsibility and must not be replaced by an assessor's later confirmation.

## Entry points

Begin with every payment stage and acceptance channel, including card-present, card-not-present, e-commerce, authorization, capture, settlement, chargeback, refund, support, and exception handling. Locate data flows, account-data locations, applications, transmissions, backups, and third-party connections. Include disaster-recovery and failover paths.

## Causal scope classes

Classify a component as `cde` when it stores, processes, or transmits account data. Classify it as `connected` when it has connectivity to the CDE. Classify it as `security-impacting` when compromise or misoperation could change CDE confidentiality, integrity, availability, authorization, deployment, network enforcement, logging, recovery, or administrative control. Use `out-of-scope-claim` only while the isolation claim is explicit and pending or supported. Use `unresolved` when evidence conflicts or is absent.

Common security-impacting components include identity providers, bastions, remote-access services, CI/CD systems, configuration and secret stores, DNS, network controls, hypervisors and control planes, centralized logging, endpoint/security management, backups, recovery systems, support tooling, and third parties with CDE access.

## Evidence discipline

Prefer diagrams, configurations, route and policy evidence, deployment manifests, data inventories, service ownership, contracts, observed flows, and bounded technical tests. Preserve the date and provenance of every claim. Do not place real account data in Cyberful artifacts; record only its class and location evidence.

A completed trace explains why each included component is in scope, why each excluded environment cannot impact the CDE even if compromised, which segmentation methods need testing, and which gaps prevent a defensible boundary.
