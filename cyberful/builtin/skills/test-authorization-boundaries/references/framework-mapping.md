# Authorization Framework Mapping

Framework identifiers are routing and reporting aids, not substitutes for a demonstrated authorization decision. Map the observed mechanism, affected control, or adversary behavior only after the evidence establishes it.

## Direct anchors

- **NIST CSF 2.0 `PR.AA`**: use when the observation supports or contradicts the intended identity, authentication, or access-control outcome. This is control evidence, not a vulnerability identifier.
- **MITRE ATT&CK `T1078` Valid Accounts**: use only when valid-account abuse is part of the demonstrated adversary path. A generic IDOR or tenant-isolation defect does not automatically become `T1078`.

## Conditional frameworks

- **MITRE ATLAS**: map only when the protected resource or delegated authority is part of an AI/ML system and the demonstrated path matches an ATLAS behavior. Route broader agent, retrieval, memory, or model-boundary analysis to `audit-ai-agent-security`.
- **MITRE D3FEND**: map a concrete defensive technique implemented by the enforcement path, such as an authorization or policy decision mechanism. Do not label the vulnerability itself as a defensive technique.
- **NIST AI RMF**: map only when the authorization decision changes an AI-system risk outcome or control responsibility. Ordinary application access control remains under CSF `PR.AA`.
- **MITRE F3**: map only after the authorization path enables a concrete cyber-enabled financial-fraud behavior. Financial impact by itself is not enough.

## Application-security classifications

Use the narrowest mechanism supported by the evidence: OWASP API1:2023 for object-level authorization, API3:2023 for object-property authorization, API5:2023 for function-level authorization, and CWE-639, CWE-862, or CWE-863 when the implementation evidence supports that weakness. Preserve version labels in the report and do not infer an identifier from a scanner label alone.
