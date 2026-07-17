---
name: operate-kubernetes-toolchain
description: Operate kubectl, kube-bench, Trivy, Prowler, and manifest/runtime evidence for advanced Kubernetes security assessment. Use for context and RBAC mapping, workload-identity analysis, admission and Pod Security review, node benchmark interpretation, secret and network boundary review, cluster escape-path analysis, or reconciliation of declared manifests with live objects.
---

# Operate Kubernetes Toolchain

Analyze Kubernetes as interacting API, admission, workload, identity, network, node, and cloud control planes. A manifest-only review and a cluster-only scan each omit decisive evidence.

## Pin context and visibility

Before using kubectl, record kubeconfig source, current context, server certificate identity, cluster UID if observable, namespace, user, impersonation settings, API version, and current authorization. Never rely on the context name alone.

Build a collection ledger for cluster-scoped and namespaced resource types, API discovery failures, forbidden responses, pagination, omitted CRDs, and namespaces not visible to the current principal.

## Map effective authorization

Enumerate role bindings, cluster role bindings, aggregated roles, service accounts, token projection, impersonation, escalation/bind permissions, webhook-dependent authorization, and cloud workload identity. Use auth can-i checks as probes, not a complete graph: resource names, subresources, non-resource URLs, admission behavior, and external identity still require inspection.

Read [references/kubernetes-fieldbook.md](references/kubernetes-fieldbook.md) for high-value primitives and benchmark caveats.

## Reconcile desired and live state

Compare source manifests, Helm/Kustomize output, GitOps desired state, and live objects. Focus on mutated defaults, injected sidecars, generated RBAC, image digest drift, ephemeral containers, admission exemptions, runtime classes, host mounts, device access, capabilities, seccomp/AppArmor/SELinux, and service-account token behavior.

Scan images and IaC with Trivy, then verify critical findings against the exact running image digest and pod spec.

## Use kube-bench correctly

Run kube-bench only where host files, process state, and configuration paths are actually mounted and visible. Select the benchmark matching distribution and Kubernetes version. Treat skipped or missing-file checks as coverage gaps, especially on managed control planes where the provider owns components.

## Build attack and containment paths

Trace from exposed workload to service account, secret/config access, API permissions, adjacent namespaces, node primitives, cloud metadata/workload identity, registry, CI/GitOps controller, and control-plane influence. Evaluate NetworkPolicy in both directions and include DNS, host networking, node-local services, and policy-engine coverage.

## Deliver

Preserve context identity, visibility ledger, API errors, live object excerpts, desired/live diffs, RBAC paths, benchmark profile and mount assumptions, image digests, and bounded proof. Separate "not allowed," "not visible," "not applicable," and "not tested."
