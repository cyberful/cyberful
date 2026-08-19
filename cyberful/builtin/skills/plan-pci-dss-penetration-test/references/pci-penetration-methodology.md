# PCI DSS penetration-test methodology

Use PCI DSS v4.0.1 Requirement 11.4 as the normative baseline. Requirement 11.4.1 requires the entity's documented methodology to use industry-accepted approaches; cover the entire CDE perimeter and critical systems; test from inside and outside the network; validate segmentation and scope-reduction controls; cover application and network layers; consider threats and vulnerabilities from the prior 12 months; define risk treatment; and retain penetration-test and remediation results for at least 12 months.

Requirements 11.4.2 and 11.4.3 distinguish internal and external testing. Each follows the defined methodology, occurs at least every 12 months and after significant infrastructure or application changes, and is performed by a qualified resource with organizational independence. Requirement 11.4.4 links identified exploitable weaknesses to risk-based correction and repeated testing.

The September 2017 PCI SSC Penetration Testing Guidance v1.1 is supplemental and references PCI DSS 3.2 Requirement 11.3. Use its durable methodological ideas—pre-engagement, engagement, post-engagement, CDE and critical-system scope, rules of engagement, tester qualifications, segmentation checks, reporting, cleanup, remediation, and retesting—but resolve requirement identifiers and current obligations against PCI DSS v4.0.1.

## Coverage decisions

- Distinguish a vulnerability scan from a penetration test. Scanning may inform test strategy but does not demonstrate attacker paths or replace competent manual analysis.
- Tie each vantage point to the boundary it represents. Internal testing includes perspectives inside the CDE and paths into it from trusted and untrusted internal networks. External testing covers the exposed perimeter and critical systems accessible through public infrastructure.
- Cover application roles, APIs, administrative paths, network functions, operating systems, remote access, wireless where relevant, third-party connections, and systems capable of impacting CDE security.
- Treat production-equivalent testing as evidence only when equivalence is demonstrated and every exploitable weakness is corrected and retested in production as required by the engagement.
- Define what constitutes a significant change for this environment and who initiates testing after one.

## Rules of engagement

Record approved targets and vantage points, test identities, excluded effects, windows, rate and concurrency ceilings, incident contacts, notification thresholds, fragile systems, detection-control behavior, data-handling rules, stop conditions, restoration, and evidence retention. If account data is encountered, stop or continue only as the agreement permits, notify the designated owner, minimize collection, and protect every resulting artifact as in-scope evidence.

## Completion evidence

A defensible plan links every required coverage element to an owner, execution path, expected artifact, and completion condition. It also records exclusions, unresolved scope, service-provider dependencies, remediation ownership, and the retest evidence needed to close each discovered weakness.
