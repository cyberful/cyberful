---
name: audit-kubernetes-policy-enforcement
description: Audit Kubernetes admission and policy-as-code enforcement against local workload manifests, exception paths, namespace scope, and deployment evidence. Use for Gatekeeper, Kyverno, ValidatingAdmissionPolicy, Conftest, or Pod Security policy review.
metadata:
  domain: cloud-security
  subdomain: kubernetes-policy
  triggers:
    - kubernetes policy enforcement audit
    - admission control review
    - kyverno policy audit
    - gatekeeper constraint review
    - pod security enforcement
    - conftest kubernetes
  tags:
    - kubernetes
    - admission-control
    - policy-as-code
    - conftest
    - kyverno
    - gatekeeper
  frameworks:
    nist_csf:
      - PR.PS-01
      - PR.AA-05
      - ID.RA-01
---

# Audit Kubernetes Policy Enforcement

Separate policy intent, policy source, admission wiring, namespace selectors, exceptions, failure mode, and admitted workload state. A passing local policy test proves only the supplied manifest/policy pair; it does not prove the cluster enforces the same version.

## Compare local artifacts

Read [references/kubernetes-policy-proof.md](references/kubernetes-policy-proof.md). For a bounded offline Conftest campaign, stage [scripts/run_kubernetes_policy_campaign.py](scripts/run_kubernetes_policy_campaign.py), [assets/kubernetes-policy-campaign.example.json](assets/kubernetes-policy-campaign.example.json), and [assets/kubernetes-policy-campaign.schema.json](assets/kubernetes-policy-campaign.schema.json). The orchestrator confines and snapshots both manifest and policy trees; `scope_reference` attributes the externally authorized mission but never grants authority. It invokes only the trusted `conftest` command from an isolated working directory, blocks network syscalls including policy `http.send`, removes credential-bearing ambient state, and preserves bounded raw scan and version output described by [assets/kubernetes-policy-evidence.schema.json](assets/kubernetes-policy-evidence.schema.json).

## Prove enforcement

Correlate local results with supplied admission configuration, policy revision, bindings, selectors, exclusions, service health, failure policy, and admitted-object evidence. Confirm a gap only when an in-scope workload can reach admission or runtime state outside the intended invariant; distinguish an untested manifest, a policy logic defect, a binding gap, and an operational outage.
