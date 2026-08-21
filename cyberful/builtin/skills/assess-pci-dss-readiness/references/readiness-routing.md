# PCI DSS readiness routing

This skill supports penetration-testing readiness and the CDE-scoping evidence needed to plan that testing. PCI DSS v4.0.1 contains twelve principal requirements and formal validation processes; a complete assessment requires the entity's applicable requirement set, chosen defined or customized approaches, reporting instrument, assessor responsibilities, and compliance-accepting entity. Do not infer those from a penetration-test report.

## Supported readiness questions

- Is the CDE boundary supported by current data flows, connected and security-impacting components, third-party paths, and segmentation evidence?
- Does the defined methodology cover every element of Requirement 11.4.1?
- Are internal and external tests current, change-triggered, qualified, and organizationally independent under 11.4.2 and 11.4.3?
- Are identified exploitable weaknesses corrected and retested under 11.4.4?
- When segmentation is used, are 11.4.5 and service-provider-specific 11.4.6 evidence applicable and current?
- For a multi-tenant service provider, is customer support for external testing under 11.4.7 evidenced?
- Is the entity's scope-confirmation evidence current under 12.5.2 and, for service providers, 12.5.2.1?

## Unsupported conclusions

Do not produce a compliance certificate, AOC, ROC, completed SAQ, QSA opinion, or blanket claim that all PCI DSS controls are in place. Record a dependency when another requirement, formal assessor decision, compensating control, customized approach, or payment-brand instruction affects the outcome.

Readiness is an evidence state: `supported`, `gap`, `blocked`, or `not-applicable-with-rationale`. A technical vulnerability does not automatically determine formal compliance, and an apparently complete document set does not prove effective controls.
