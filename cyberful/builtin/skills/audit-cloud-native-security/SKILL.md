---
name: audit-cloud-native-security
description: Route a cloud-native security audit across effective IAM, infrastructure as code, build and release paths, containers, Kubernetes, serverless workloads, secrets, event sources, and control-plane evidence. Use when the assignment spans multiple cloud-native boundaries or the correct specialist is not yet clear.
metadata:
  domain: cloud-security
  subdomain: cloud-native-security
  triggers:
    - cloud native audit
    - infrastructure as code review
    - kubernetes policy review
    - serverless security
    - workload identity
    - cloud control plane
  tags:
    - cloud-iam
    - kubernetes
    - containers
    - serverless
    - iac
    - workload-identity
  frameworks:
    mitre_attack:
      - T1078.004
      - T1552.005
      - T1610
      - T1611
    nist_csf:
      - ID.AM-02
      - ID.RA-01
      - PR.AA-05
---

# Audit Cloud-Native Security

Use this router to decompose a broad cloud-native assignment. Read every selected specialist's `SKILL.md` completely before applying its procedure; this entrypoint supplies routing and shared scope only.

## Route by security question

- Source IaC, generated plans, modules, state exposure, provider defaults, or drift: `audit-infrastructure-as-code`.
- CI identity, untrusted contributions, build jobs, artifact promotion, signing, or deployment authority: `audit-build-release-pipelines`.
- Function identity, event sources, invocation policy, packaging, ephemeral storage, or platform configuration: `audit-serverless-security`.
- RBAC, admission, policy engines, namespace boundaries, or declared-versus-enforced Kubernetes controls: `audit-kubernetes-policy-enforcement`.
- Container privileges, capabilities, mounts, namespaces, host reach, runtime controls, or escape paths: `audit-container-runtime-isolation`.
- Secret creation, storage, access, injection, rotation, revocation, or auditability: `audit-secrets-management`.
- A secret's propagation through code, jobs, logs, artifacts, workloads, or downstream services: `trace-secret-propagation`.
- Serverless event authenticity, replay, ordering, destination binding, or cross-tenant dispatch: `test-serverless-event-security`.
- Cloud logs, IAM evaluations, resource snapshots, scanner exports, or control-plane records requiring offline reconciliation: `analyze-cloud-control-plane-evidence`.

## Establish the shared scope

Before routing, record the authorized accounts, projects, subscriptions, regions, clusters, namespaces, repositories, environments, and evidence sources. Identify the initial principals and the control-plane or data-plane boundary under review. Do not infer permission to enumerate or mutate a live cloud environment from repository access alone.

When several specialists apply, order them by dependency: declared configuration and build provenance first, effective identity and runtime enforcement second, raw evidence analysis last. Preserve disagreements among source, plan, deployment, runtime, and logs rather than collapsing them into one assumed state.

## Deliver integrated evidence

Report each path as an initial principal or input, the exact authority or trust edges, the reachable workload or resource, the observed effect, and the specialist evidence supporting it. Missing credentials, runtime visibility, or deployment state are coverage limits, not proof that a control exists.
