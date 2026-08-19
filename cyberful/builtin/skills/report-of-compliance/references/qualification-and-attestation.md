# Qualification and attestation boundary

Separate four states that are often conflated: evidence has been collected; evidence has been reviewed; a draft report has been approved internally; an authorized person has issued a formal attestation or compliance conclusion. The compiler performs only the first two organizational steps and always emits `document_status: draft`.

For PCI DSS, preserve the assessor name, organization, and declared qualification, but do not validate those claims or produce a QSA/ISA signature, AOC, official ROC, or compliance certificate. Only the applicable PCI program, official forms, qualified participants, and accepting entity determine the formal validation path.

For GDPR, record the controller or processor decision owner, DPO involvement where applicable, legal-review status, jurisdiction, and unresolved interpretation. A DPO or counsel review does not become a regulator-issued certification, and a Cyberful report does not replace an Article 42 certification mechanism.

Always show limitations, unobserved needs, conflicting evidence, report version, profile version, source digests, assessment period, and evidence cutoff. Remove `draft` only outside Cyberful after the responsible qualified parties complete their own review and authorized signing process.
