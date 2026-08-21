---
name: analyze-cloud-control-plane-evidence
description: Deterministically reconcile bounded offline cloud control-plane snapshots to expose resource, public-access, principal, policy, encryption, logging, and lifecycle drift without querying a live provider.
metadata:
  domain: cloud-security
  subdomain: control-plane-evidence
  triggers:
    - analyze cloud control plane evidence
    - compare cloud snapshots
    - cloud resource drift evidence
    - reconcile IAM observations
    - offline cloud posture analysis
  tags:
    - cloud
    - control-plane
    - snapshots
    - drift
    - IAM
    - offline-analysis
  frameworks:
    nist_csf:
      - ID.AM-02
      - DE.AE-03
---

# Analyze Cloud Control-Plane Evidence

Reconcile normalized snapshots as evidence, not as a live provider truth source. Preserve provider, account or project, capture time, collector identity, scope limitations, and raw resource identity.

Stage [scripts/analyze_cloud_control_plane.py](scripts/analyze_cloud_control_plane.py), its [manifest](scripts/manifest.json), and the [example](assets/cloud-control-plane-input.example.json). The analyzer is offline, reads only confined regular JSON snapshots, starts no child process, and writes deterministic bounded drift evidence under the [output schema](assets/cloud-control-plane-evidence.schema.json).

Read [control-plane-evidence-method.md](references/control-plane-evidence-method.md) before treating an absent resource or changed control as drift. A collector can omit fields it lacked permission to observe.

## Interpret deltas

Separate added, removed, and changed resources. For changes, compare public exposure, principals, policy digest, encryption, logging, and lifecycle state field by field. Escalate the mechanism to the relevant cloud audit or identity specialist; this skill does not infer exploitability or make live calls.
