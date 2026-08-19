---
name: audit-container-runtime-isolation
description: Audit container runtime isolation across namespaces, capabilities, seccomp, mandatory access control, mounts, devices, daemon sockets, cgroups, identity, and host integration. Use for container configuration or runtime-boundary review.
metadata:
  domain: cloud-security
  subdomain: container-runtime
  triggers:
    - container runtime isolation audit
    - container escape control review
    - seccomp capability audit
    - privileged container review
    - container mount security
    - runtime class isolation
  tags:
    - containers
    - runtime-isolation
    - seccomp
    - capabilities
    - namespaces
    - host-boundary
  frameworks:
    nist_csf:
      - PR.PS-01
      - PR.PS-05
      - ID.RA-01
---

# Audit Container Runtime Isolation

Evaluate the effective host boundary, not the image alone. Start with the runtime, kernel, workload configuration, orchestrator mutations, node placement, and host integrations that determine what the container can reach.

## Build the boundary matrix

Read [references/container-isolation-method.md](references/container-isolation-method.md). Populate [assets/container-isolation-matrix.example.json](assets/container-isolation-matrix.example.json) using [assets/container-isolation-matrix.schema.json](assets/container-isolation-matrix.schema.json). Record each isolation layer, effective setting, provenance, protected host resource, bypass precondition, and evidence.

Trace user and group mapping, privilege mode, capabilities, seccomp, AppArmor or SELinux, namespaces, cgroups, devices, mounts, proc/sys exposure, daemon and runtime sockets, host networking, kernel interfaces, runtime class, and node trust. Treat a missing hardening control as risk evidence; confirm exploitability only when a reachable primitive crosses a protected boundary.

## Report precisely

Separate workload takeover, cross-container access, node-level effect, and cluster control-plane effect. Record the minimum attacker foothold, required kernel/runtime behavior, effective configuration, compensating controls, and a harmless verification path suitable for an isolated lab.
