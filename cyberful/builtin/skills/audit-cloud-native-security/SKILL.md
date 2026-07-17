---
name: audit-cloud-native-security
description: Audit cloud IAM, workload identity, infrastructure as code, containers, Kubernetes, serverless, secrets, network boundaries, control planes, storage, and tenancy during authorized code audits and security assessments. Use for privilege escalation, confused deputies, metadata and identity abuse, exposed resources, IaC drift, container escape paths, admission-policy gaps, cross-namespace access, and cloud control-plane compromise.
---

# Audit Cloud-Native Security

## Build the Effective Authority Graph

Model principals, groups, roles, policies, trust policies, workload identities, service accounts, resources, data planes, control planes, and delegation edges. Include conditions, boundaries, deny rules, session policies, organization policy, resource policy, and identity federation.

Evaluate effective capability, not policy text in isolation. Ask whether a principal can directly act, pass an identity, modify code or configuration executed by another identity, alter a trust relationship, read credentials, or influence a deployment.

Read [iam-secrets-network.md](references/iam-secrets-network.md) for identity and boundary review. Read [containers-kubernetes-serverless.md](references/containers-kubernetes-serverless.md) for workload platforms. Read [iac-and-drift.md](references/iac-and-drift.md) for configuration provenance.

## Trace Workload Identity

For each workload, record runtime identity, token issuance, audience, subject, TTL, refresh, metadata access, mounted credentials, node or host fallback, and downstream impersonation. Determine whether tenant input can select role, account, project, subscription, namespace, or resource.

Review confused-deputy protections when a service performs cloud actions for users. Bind requested resource and delegated identity to the authenticated tenant and business authorization.

## Evaluate Control-Plane Mutation

Prioritize capabilities that:

- pass or attach privileged roles;
- update function, job, image, template, user-data, or startup code;
- mutate admission, policy, network, logging, or key controls;
- create credentials or federation;
- alter build or deployment systems;
- read secrets, snapshots, backups, or state;
- schedule workloads onto privileged nodes or identities.

Read-only labels often conceal write-equivalent paths such as snapshot restore, policy simulation with data, function invocation, or signed URL generation.

## Correlate Configuration With Runtime

Compare source IaC, plan, deployed configuration, admission result, and live workload. Account for defaults, generated resources, manual changes, controllers, operators, inheritance, and provider-side mutation.

## Report an Attack Path

State initial principal or network position, exact authority edges, conditions, reachable resource, resulting identity or data capability, and any cross-account or cross-tenant boundary. Recommend removing the graph edge, narrowing trust conditions, separating identities, enforcing policy before deployment, and detecting drift.
