---
name: audit-infrastructure-as-code
description: Audit infrastructure-as-code artifacts for unsafe defaults, policy gaps, privilege exposure, control drift, and deployment-impact evidence. Use for Terraform, CloudFormation, Bicep, Pulumi, Kubernetes manifests, or mixed IaC repositories.
metadata:
  domain: cloud-security
  subdomain: infrastructure-as-code
  triggers:
    - infrastructure as code audit
    - terraform security review
    - cloudformation audit
    - bicep security analysis
    - pulumi security review
    - iac policy findings
  tags:
    - iac
    - terraform
    - cloudformation
    - policy-as-code
    - cloud-controls
    - static-analysis
  frameworks:
    nist_csf:
      - PR.PS-01
      - PR.PS-06
      - ID.RA-01
---

# Audit Infrastructure as Code

Treat IaC as a proposed control-plane state, not proof of the deployed state. Establish which modules, environments, overlays, generated files, policy exceptions, and deployment identities are in scope before interpreting a scanner result.

## Build evidence

Read [references/iac-evidence-method.md](references/iac-evidence-method.md) for the provenance and reachability method. Trace each material setting from module input through locals, composition, generated plans, and environment overlays to the resource property that a deployment would apply. Separate unsafe defaults, explicitly selected risk, dead configuration, and scanner uncertainty.

For a bounded offline Checkov run, stage [scripts/run_iac_audit_campaign.py](scripts/run_iac_audit_campaign.py), [assets/iac-audit-campaign.example.json](assets/iac-audit-campaign.example.json), and [assets/iac-audit-campaign.schema.json](assets/iac-audit-campaign.schema.json). The campaign accepts only a confined local source tree and limits; `scope_reference` attributes the externally authorized mission but never grants authority. It scans a read-only content snapshot with the fixed runtime `checkov` command, blocks network syscalls, ignores ambient tool configuration, strips proxy and credential-bearing state, and preserves bounded raw scan and version output under [assets/iac-audit-evidence.schema.json](assets/iac-audit-evidence.schema.json).

## Reach a conclusion

Confirm a finding only when the effective configuration reaches an in-scope deployment path and weakens a named security invariant. Record the affected resource, value provenance, environment, deployment precondition, compensating control, raw tool evidence, and smallest safe correction. Treat provider defaults and generated plans as evidence to obtain, not assumptions.
