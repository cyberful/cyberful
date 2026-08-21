# Container isolation method

## Effective configuration chain

Trace `image metadata -> workload manifest -> policy mutation/default -> runtime handler -> OCI spec -> kernel enforcement`. Retain each rendered artifact when available; source YAML alone may not represent the runtime boundary.

## Isolation layers

- Identity: container UID/GID, user namespaces, supplementary groups, filesystem ownership, and host identity mapping.
- Privilege: privileged mode, capabilities, no-new-privileges, seccomp, and mandatory access control.
- Resources: cgroups, PID limits, memory behavior, device access, huge pages, and denial-of-service containment.
- Namespaces: mount, PID, network, IPC, UTS, cgroup, and user namespace sharing.
- Host interfaces: host paths, proc/sys, container/runtime sockets, device nodes, kernel modules, eBPF, and debug interfaces.
- Placement: node pools, runtime classes, sandbox runtimes, taints, tolerations, and mixed-trust workloads.

Grade an observation by the protected host primitive it exposes and the foothold needed to use it. Do not equate a configuration smell with a working escape.
