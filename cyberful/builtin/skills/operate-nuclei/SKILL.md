---
name: operate-nuclei
description: Operate ProjectDiscovery Nuclei for authorized template-driven scanning, template selection, and result triage. Validate matches before treating them as findings.
metadata:
  domain: security-tooling
  subdomain: dynamic-scanning
  triggers:
    - Nuclei template scan
    - ProjectDiscovery scanning
    - template-driven vulnerability scan
    - Nuclei result triage
  tags:
    - nuclei
    - nuclei_templates
    - template-scanner
    - projectdiscovery
    - dynamic-analysis
  frameworks: {}
---

# Operate Nuclei

`nuclei` exposes the complete CLI. Cyberful adds only `-disable-update-check`; it caps no templates, rate, concurrency, redirects, OAST, tags, markers, or scan choices. Mission and program policy still apply.

`nuclei_templates` is an optional offline `-tl` corpus preview and need not precede a run. Treat matches as leads until effect and a control support a verdict.
