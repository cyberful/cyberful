---
name: threat-model-application
description: Build or challenge an application threat model from architecture, dataflows, identities, trust boundaries, business invariants, dependencies, and deployment context. Use for design reviews, code-audit planning, pentest hypothesis generation, feature changes, abuse-case discovery, control requirements, architecture assessment, or residual-risk analysis.
---

# Threat Model an Application

Produce a model that participants recognize as the real system and that generates testable security requirements. Do not produce a generic STRIDE checklist detached from architecture.

## Answer the four questions

1. What are we building or assessing?
2. What can go wrong?
3. What will prevent, detect, contain, or recover from it?
4. How will we know the model and controls are good enough?

## Model the system

Capture:

- assets and unacceptable outcomes;
- actors, identities, roles, tenants, assurance levels, and machine principals;
- processes, data stores, queues, caches, browsers, clients, build systems, and external services;
- dataflows with protocol, parser, authentication context, sensitivity, and direction;
- trust boundaries, privilege transitions, administrative planes, and human approvals;
- lifecycle states, revocation, failure modes, retries, fallback, recovery, and decommissioning;
- assumptions about networks, callers, providers, model behavior, and deployment configuration.

Read [references/elicitation-catalog.md](references/elicitation-catalog.md) for structured threat elicitation. Use [references/model-quality.md](references/model-quality.md) to challenge completeness.

## Start from unacceptable outcomes

Express outcomes in product language:

- another tenant's data or authority becomes reachable;
- identity is created, linked, recovered, or elevated without required evidence;
- money, inventory, quota, entitlement, or approval changes outside the business invariant;
- untrusted content controls an interpreter, parser, fetcher, tool, build, or deployment;
- secrets or sensitive data cross an unintended audience, persistence, or retention boundary;
- one actor can impose disproportionate compute, storage, cost, fan-out, or operational load;
- audit, revocation, or recovery cannot reconstruct and contain the event.

Then work backward to attack paths and forward to controls.

## Elicit threats with multiple lenses

Apply only relevant lenses:

- STRIDE to each trust boundary and dataflow;
- authorization and tenant matrix to every resource and action;
- state-machine and abuse-case review to business workflows;
- privacy and data-lifecycle review to every copy;
- kill-chain or attack-tree decomposition to high-value outcomes;
- CAPEC/CWE/OWASP catalogs to avoid known blind spots;
- supply-chain and deployment review to pre-runtime authority;
- agentic-AI review to instruction, memory, retrieval, output, and tool boundaries.

Catalogs supplement adversarial reasoning; they do not replace it.

## Convert threats into requirements

For each material threat record:

`threat | preconditions | path | affected asset/invariant | preventive control | detective/recovery control | owner | verification method | residual risk`

Make requirements specific and testable. Prefer "service verifies tenant membership against the authoritative resource on every mutation" over "implement access control." Identify the enforcement layer and failure behavior.

## Derive tests and code-review targets

Translate each threat into at least one negative test, control inspection, monitoring assertion, or recovery exercise. Route dynamic tests to the authorized pentest ledger and static tests to concrete entry points, policies, and sinks. Preserve threats whose verification requires unavailable environments as explicit residual uncertainty.

## Maintain the model

Revisit when identity, dataflow, parser, dependency, privilege, deployment, tool authority, business state, or external integration changes. Link model elements to code, configuration, tests, owners, and findings so the model is reviewable rather than ornamental.

## Authoritative anchors

- OWASP Threat Modeling Project: https://owasp.org/www-project-threat-modeling/
- Threat Modeling Manifesto: https://www.threatmodelingmanifesto.org/
- NIST SP 800-154: https://csrc.nist.gov/pubs/sp/800/154/ipd
- MITRE CAPEC: https://capec.mitre.org/
