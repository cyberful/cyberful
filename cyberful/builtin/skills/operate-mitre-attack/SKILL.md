---
name: operate-mitre-attack
description: Use the release-embedded MITRE ATT&CK snapshot as a threat-informed reasoning lens without allowing the framework to constrain novel vulnerability discovery.
metadata:
  domain: security-tooling
  subdomain: threat-informed-analysis
  triggers:
    - MITRE ATT&CK reasoning
    - adversary tactic and technique mapping
    - threat-informed hypothesis organization
    - ATT&CK relationship analysis
    - ATT&CK mapping verification
  tags:
    - mitre-attack
    - stix
    - threat-informed
    - ttp
    - zero-day
  frameworks: {}
---

# Operate MITRE ATT&CK

Use `mitre_attack` as the authoritative source for ATT&CK definitions, identifiers, objects, matrices, and relationships. Call `status` before relying on the dataset. Never substitute model-training knowledge when the tool is unavailable; record `UNAVAILABLE` with a rationale instead.

## Tool contract

The tool has five mutually exclusive actions. Send only the fields shown for the selected action; an irrelevant field is an invalid request.

```json
{"action":"status"}
{"action":"search","query":"Valid Accounts","domains":["enterprise"],"object_types":["technique"],"tactics":["initial-access"],"platforms":["Windows"],"include_revoked":false,"include_deprecated":false,"limit":20}
{"action":"get","identifiers":["T1078.004"],"domains":["enterprise"]}
{"action":"relationships","identifiers":["G0034"],"domains":["enterprise"],"direction":"outgoing","relationship_types":["uses"],"include_indirect":false,"include_revoked":false,"limit":100}
{"action":"matrix","domain":"enterprise","platform":"Windows","tactics":["credential-access"],"include_revoked":false,"include_deprecated":false,"limit":20}
```

- `status` returns `ready` plus the immutable snapshot manifest, or `unavailable` with `DATASET_UNAVAILABLE`. An `INVALID_REQUEST` means repair the call; it does not mean the dataset is unavailable.
- `search` requires `query`, returns at most 100 objects, combines search tokens with AND, and requires every supplied tactic and platform filter to match. Reuse `next_cursor` only with the identical query, filters, and limit.
- `get` requires 1–20 exact ATT&CK or STIX identifiers and may return more than one domain when `domains` is omitted. Exact lookup intentionally returns matching revoked or deprecated objects so inspect their flags before mapping.
- `relationships` requires 1–20 identifiers. `direction` is relative to the resolved objects and defaults to `both`; `domains`, `relationship_types`, and `include_revoked` apply to returned relationships. `include_indirect` additionally derives outgoing group → software → technique paths marked `indirect: true` and `relationship_type: uses-via-software`; request that synthetic type alone when only indirect paths are needed. `endpoints_truncated: true` means resolve missing endpoint objects with `get`.
- `matrix` requires one `domain`. Optional `tactics` accepts tactic ATT&CK IDs, STIX IDs, or exact short names. `limit` defaults to 5 and caps technique records per tactic at 50; use `total_techniques` and `truncated`, then narrow by tactic or resolve selected techniques with `get` instead of requesting an unnecessarily broad matrix.

Every successful data response includes the complete `snapshot` manifest, and each object or relationship includes `snapshot_id`. Preserve the returned ATT&CK ID, STIX ID, domain, snapshot ID, rationale, and primary evidence references in any proposed mapping.

ATT&CK is a reasoning lens and shared vocabulary, not a vulnerability taxonomy, checklist, discovery boundary, or completeness claim. Give zero-days, new primitives, novel exploit chains, business-logic failures, CWE/OWASP classes, application-specific bugs, and behavior absent from ATT&CK the same investigative priority their evidence and impact warrant. The absence of a mapping must never lower severity, confidence, reward potential, priority, phase advancement, finding promotion, or report eligibility. A generic Firefox defect, for example, is not mapped merely because Firefox is a target; credential stuffing may be applicable when the observed behavior supports a technique. Read [the applicability and review policy](references/applicability-and-review.md) before recording an assessment.

When ATT&CK applies, use it to organize adversary goals, behaviors, dependencies, and post-compromise paths. Prefer the most specific supported sub-technique, but never infer specificity from a product name or expected attacker behavior. Label direct relationships separately from indirect paths. A mapping is context, not proof that a vulnerability exists.

For a hypothesis, call `hypothesis` with `action: set_attack_assessment`, its `id`, and an `assessment`: select `APPLICABLE`, `NOT_APPLICABLE`, or `UNAVAILABLE`; state the rationale; and attach `evidence_refs` to every proposed mapping. New hypotheses remain `UNASSESSED` until this is done, but missing mappings never block work or handoff. Promotion copies the assessment to the finding. Use `finding` with the same `set_attack_assessment` action to revise an already promoted finding directly.

```json
{
  "action": "set_attack_assessment",
  "id": "H-EXAMPLE-1",
  "assessment": {
    "applicability": "APPLICABLE",
    "mappings": [
      {
        "attack_id": "T1078.004",
        "stix_id": "attack-pattern--…",
        "domain": "enterprise",
        "rationale": "The preserved behavior shows abuse of an existing cloud account.",
        "evidence_refs": ["raw/evidence/account-abuse.json"]
      }
    ]
  }
}
```

For `NOT_APPLICABLE` or `UNAVAILABLE`, send an empty `mappings` array and a non-empty assessment `rationale`. Outside Verify leave `review` omitted or `NOT_REVIEWED`. Verify re-queries the object and supplies `review` plus `review_rationale`; `ACCEPTED` or `REVISED` requires an `APPLICABLE` assessment with supported mappings.

Verify independently re-queries the same embedded snapshot, checks the evidence for each association, and records `ACCEPTED`, `REVISED`, or `REJECTED`. Report publishes mappings only after that review. Rejection of a mapping does not reject the vulnerability.
