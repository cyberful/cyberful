---
name: operate-cloud-posture-toolchain
description: Operate Prowler, Cloudsplaining, cloud CLIs, policy documents, and resource evidence for advanced AWS, Azure, GCP, and Kubernetes-adjacent posture assessment. Use for multi-account or multi-project baselines, effective-IAM analysis, trust-boundary mapping, resource-policy review, scanner reconciliation, or distinguishing absent controls from controls invisible to the current credentials.
---

# Operate Cloud Posture Toolchain

Treat every cloud scan as a view through one principal. A missing resource may mean absent, out of region, filtered, unpaginated, unsupported, or denied. Model visibility before interpreting compliance.

## Capture the authority envelope

Record provider, organization/tenant, account/subscription/project, principal ARN or object identity, assumed-role chain, session policy, permission boundary, organization policies, enabled regions, API endpoints, credential source, collection time, and explicit/implicit API denials.

Build a visibility ledger: resource family, enumeration API, region/scope, result count, pagination status, denied calls, and independent expected count.

## Run broad posture and focused IAM analysis

Use Prowler with pinned provider/account/region scope and machine-readable output. Keep failed checks, muted checks, API errors, and unsupported checks distinct.

Use Cloudsplaining against collected AWS IAM policies to surface privilege escalation, data exposure, infrastructure modification, and resource-constraint gaps. Then reconstruct effective access across identity policy, resource policy, trust policy, session policy, permissions boundary, service-control policy, conditions, grants, and service-specific authorization.

Read [references/cloud-iam-fieldbook.md](references/cloud-iam-fieldbook.md) when analyzing effective authority or cross-account paths.

## Prioritize chains

Prefer findings that connect:

1. an exposed or compromisable principal;
2. a permission or trust transition;
3. a target resource or stronger identity;
4. an observable security consequence.

High-value pivots include pass/attach role, workload identity mutation, build/deployment control, key-policy control, secret read plus compute execution, log/audit disablement, public resource-policy paths, and organization boundary escape.

## Diagnose false assurance

Reconcile scanner output with provider-native queries for representative critical checks. Investigate disabled regions, delegated administrator accounts, organization-wide services, service-linked roles, eventually consistent APIs, conditional policies, wildcard resources that are service-limited, and policies attached outside the collected account.

Never label a denied enumeration as compliant. Mark it unassessed with the missing API and likely effect on coverage.

## Deliver

Preserve principal identity, scope manifest, visibility ledger, raw outputs, provider evidence, policy documents, evaluated condition context, chain graph, rejected scanner findings, and residual unknowns. Report the smallest policy/control change that breaks the demonstrated chain without assuming a single policy document is the whole authorization system.
