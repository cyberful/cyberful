---
name: analyze-scan-findings
description: Normalize and correlate bounded SARIF and Cyberful finding exports offline by rule, location, fingerprint, source, level, suppression, and evidence reference without treating scanner severity as verified vulnerability impact.
metadata:
  domain: evidence-analysis
  subdomain: scan-correlation
  triggers:
    - analyze scan findings
    - correlate SARIF results
    - deduplicate scanner findings
    - normalize security scan output
    - compare scanner evidence
    - triage static analysis findings
  tags:
    - sarif
    - scan-results
    - finding-correlation
    - deduplication
    - evidence-triage
    - offline-analysis
  frameworks:
    nist_csf:
      - DE.AE-02
      - DE.AE-03
---

# Analyze Scan Findings

Use this skill to organize scanner evidence before verification. A shared rule, location, message, or severity does not establish a shared mechanism, reachability, or impact.

## Normalize bounded exports

Read [references/scan-evidence-method.md](references/scan-evidence-method.md). Stage [scripts/analyze_scan_findings.py](scripts/analyze_scan_findings.py), [assets/scan-finding-analysis.example.json](assets/scan-finding-analysis.example.json), and [assets/scan-finding-analysis.schema.json](assets/scan-finding-analysis.schema.json). The analyzer snapshots confined SARIF 2.1 or strict normalized JSON files, preserves source digests and evidence references, and emits deterministic groups under [assets/scan-finding-evidence.schema.json](assets/scan-finding-evidence.schema.json).

Correlation uses supplied fingerprints when available and a documented structural fallback otherwise. Cross-source occurrence, suppression state, and repeated locations are triage facts only. Do not merge findings merely because messages are similar, and do not inherit a tool's severity as verified Cyberful impact.

## Verify outside the analyzer

Return to source and runtime context, trace reachability and authority, reproduce the mechanism, identify durable effect, and record negative controls. Keep false-positive dismissal, accepted risk, and remediation status separate from evidence normalization.
