# PCI DSS penetration-test evidence evaluation

Use the June 2024 PCI DSS v4.0.1 standard as normative. The 2017 PCI SSC Penetration Testing Guidance v1.1 is supplemental and useful for report structure, evidence retention, scoping, rules of engagement, cleanup, remediation, and retesting; translate its former Requirement 11.3 references to the current standard only where the v4.0.1 text supports that relationship.

## Evidence by requirement

- `11.4.1`: entity-defined, documented, implemented methodology; industry-accepted approach; complete CDE perimeter and critical-system coverage; inside and outside testing; segmentation and scope-reduction validation; application and network layers; prior-12-month threats and vulnerabilities; risk treatment; and at least 12 months of result and remediation retention.
- `11.4.2`: current internal test scope and results, annual and significant-change timing, qualified tester, and organizational independence.
- `11.4.3`: equivalent external testing evidence from the exposed perimeter and public-accessible critical systems.
- `11.4.4`: risk-based correction of exploitable weaknesses and repeated testing that verifies the correction under the relevant conditions.
- `11.4.5`: when segmentation is used, current coverage of every method, effectiveness against all out-of-scope systems and differing security levels, annual and change-triggered timing, qualification, and independence.
- `11.4.6`: for service providers using segmentation, the additional six-month and change-triggered testing evidence.
- `11.4.7`: for multi-tenant service providers, evidence that customers receive sufficient external-test evidence for subscribed infrastructure or prompt access to conduct their own testing.

## Evaluation rules

Check that dates, environment identity, scope versions, tester identities, source vantage points, target populations, change records, finding identifiers, remediation records, and retest identifiers reconcile across artifacts. A finding marked closed without a repeated test is not retest evidence. A segmentation sample without a population and shared-method rationale does not support full method coverage.

Separate metadata support from substantive validation. The packaged analyzer can show that a record exists and how it was classified; a reviewer must still read the underlying staged evidence, confirm its provenance, and evaluate whether it supports the claimed element.

Do not retain sensitive report content merely to improve the ledger. Store restricted evidence in the engagement's approved evidence system and place only stable references, dates, status, and bounded rationale in the Cyberful metadata ledger.
