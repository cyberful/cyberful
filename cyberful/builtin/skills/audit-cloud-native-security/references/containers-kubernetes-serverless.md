# Containers, Kubernetes, and Serverless

## Container Boundary

Review image provenance, base images, package and layer secrets, runtime user, capabilities, seccomp, AppArmor or SELinux, mounts, devices, namespaces, cgroups, host networking, privilege, socket exposure, writable paths, and kernel attack surface.

Container escape risk is contextual: identify host kernel, runtime, isolation technology, node identity, mounted sockets, and reachable control plane.

## Kubernetes Authority Graph

Map users, groups, service accounts, Roles, ClusterRoles, bindings, impersonation, admission controllers, operators, custom resources, webhooks, nodes, and cloud identity integration.

High-value edges include:

- create or patch pods with a privileged service account;
- exec, attach, port-forward, ephemeral containers, or pod subresources;
- read secrets or service-account tokens;
- create role bindings or impersonate;
- mutate validating or mutating webhooks;
- update workloads controlled by a stronger identity;
- access kubelet, etcd, API proxy, or node credentials;
- influence operators that translate custom resources into privileged actions.

Review namespace defaulting, automount behavior, projected token audiences, network policy for ingress and egress, pod security enforcement, and admission fail-open semantics.

## Serverless

Inspect trigger authorization, event source filtering, function URLs, runtime identity, environment secrets, dependency layers, temporary storage, concurrency, retries, dead-letter handling, destination configuration, and cross-tenant reuse. Warm execution contexts can retain memory or files between invocations.

## Rare Hints

- Admission evaluates the submitted object while a controller later adds privileged fields or mounts.
- An operator's custom resource is an indirect privileged API.
- Namespace-scoped write can affect cluster-scoped behavior through webhooks, ingress classes, storage classes, or shared controllers.
- A read-only pod log endpoint may expose projected tokens or application credentials.
- Image pull permissions and mutable tags can replace code without Kubernetes API write.
- Serverless event filters may apply before decoding while the function interprets a richer nested structure.
