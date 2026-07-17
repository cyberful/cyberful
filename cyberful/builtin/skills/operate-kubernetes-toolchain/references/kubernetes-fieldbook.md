# Kubernetes Fieldbook

## High-value authorization primitives

- create/update pods or controllers that select a stronger service account;
- create pods plus access to privileged namespaces, hostPath, hostPID, hostNetwork, devices, or dangerous runtime classes;
- bind, escalate, impersonate, token, certificate-signing, or webhook-configuration permissions;
- read Secrets, exec/attach/port-forward, create ephemeralcontainers, or proxy node/pod/service APIs;
- mutate admission, API services, CRDs/controllers, GitOps objects, or validating policy exemptions;
- read service-account tokens from legacy secrets or projected volumes with broad audiences;
- control registry images or mutable tags used by privileged workloads.

## Weak signals worth pursuing

- a RoleBinding references a ClusterRole whose aggregation changes over time;
- a controller watches more namespaces than its RBAC appears to require;
- admission policy excludes system or labeled namespaces that ordinary users can influence;
- a webhook failure policy is Ignore and its service/network dependency is attacker-influenceable;
- pod security labels differ between desired and live namespace state;
- service-account automount is disabled on the pod but injected containers mount another projected token;
- egress policy permits DNS plus an attacker-steerable resolver or proxy;
- managed identity binding uses namespace/name claims without immutable cluster identity.

## kube-bench interpretation

A node benchmark needs the node's real configuration, files, and process flags. Running it in an ordinary pod without mounts can produce skips or misleading failures. On managed services, provider-owned control-plane checks may be inaccessible; assess tenant-configurable controls independently and document provider responsibility.

## False-negative traps

Hidden namespaces, forbidden API discovery, aggregated RBAC, CRD-defined policy, external admission, ephemeral containers, node authorizer behavior, subresources, non-resource URLs, cloud IAM bindings, service meshes, CNI-specific policy semantics, and live mutation after manifest rendering.

## Minimum chain evidence

For each escalation or boundary crossing, record source principal, exact verb/resource/subresource/name scope, admission result, target identity or node primitive, and resulting authority. A theoretical verb list without a realizable object path is not enough.
