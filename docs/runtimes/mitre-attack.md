# MITRE ATT&CK MCP

Cyberful ships a first-party, read-only MITRE ATT&CK MCP backed by the official STIX 2.1 Enterprise, Mobile, and ICS collections. The dataset is current at Cyberful build time and completely offline during engagements. ATT&CK supplies a threat-informed vocabulary and reasoning lens; it is not a vulnerability taxonomy, a completeness checklist, or a limit on zero-day and novel-path discovery.

## Snapshot identity

There is no globally hardcoded ATT&CK version in the runtime or documentation. Each Cyberful release identifies its exact snapshot through the embedded manifest and `mitre_attack` with `action: status`. The manifest contains the Enterprise, Mobile, and ICS versions, build-resolved source URLs, index timestamp and digest, source sizes and SHA-256 digests, SQLite schema and digest, Cyberful version, build ID, generation time, and snapshot ID.

Every MCP response carries the complete top-level snapshot manifest. Every returned ATT&CK object and relationship also carries `snapshot_id`, so copied evidence remains attributable after a later Cyberful build selects a newer ATT&CK release. The phase MCP writes the same immutable manifest to `raw/mitre-attack/snapshot.json` in the workarea.

## Build-only acquisition

`make build` begins by downloading the official `attack-stix-data` `index.json` exactly once. It fixes the first listed current release for Enterprise, Mobile, and ICS before fetching any bundle; a MITRE release published while the remaining targets compile cannot change the selected snapshot. Only versioned STIX URLs below `https://raw.githubusercontent.com/mitre-attack/attack-stix-data/` are accepted. Redirects remain on that allowlisted host and path, credentials, query strings, fragments, non-HTTPS transports, and more than three redirects are rejected.

The index is limited to 4 MiB, each domain bundle to 256 MiB, the license to 128 KiB, and every request to 120 seconds. Cyberful validates JSON, the STIX bundle and object structure, STIX 2.1 declarations, unique and type-consistent STIX IDs, ATT&CK external IDs, domain declarations, canonical official URLs, relationship endpoints, matrix tactic references, all three required domains, and a non-empty supported object, relationship, and matrix set. Any fetch or validation failure aborts the build. There is deliberately no stale-cache fallback because it could no longer prove that the snapshot was latest when the build began.

The build emits `cyberful/dist/mitre-attack/` with:

- the original `index.json` and three versioned STIX bundles;
- deterministic read-only SQLite tables and FTS5 index plus a gzip copy;
- `manifest.json`, `SHA256SUMS`, and `SBOM.spdx.json`;
- the complete build-acquired MITRE `LICENSE.txt`.

`cyberful/dist/mitre-attack-manifest.json` is the release-facing copy. ATT&CK identifiers used as skill-routing metadata are not tied to a repository pin: the skill validator checks their syntax and reviewed membership, then the build requires every identifier to exist in the newly produced database.

`make run` and other source launches never fetch ATT&CK. They use the snapshot from the most recent `make build`; if it is absent, `mitre_attack` reports `DATASET_UNAVAILABLE` and instructs the developer to build Cyberful.

## Release consistency

The GitHub Release workflow prepares one snapshot after source verification and uploads it as a private workflow artifact. macOS, Linux, and Windows jobs download that same directory, verify every declared size and digest, validate the SQLite routing IDs, and embed its compressed database and manifest. A compiled-binary smoke test starts the private stdio MCP with unusable HTTP proxy routes and compares `status` with the build manifest.

Each native job publishes its manifest beside the package artifact. Release assembly requires all four native manifests to be byte-identical to the prepared snapshot before it creates any public assets. The GitHub Release includes `cyberful-mitre-attack-<snapshot_id>.tar.gz`, a platform-neutral archive containing the original sources, derived database, manifest, checksums, SPDX metadata, and license. Normal release checksums cover that archive.

A source commit can therefore produce different bytes when built at different times. The Cyberful build ID, ATT&CK snapshot ID, manifests, and release checksums identify the result that was actually published.

## Runtime materialization

The standalone binary contains the compressed SQLite database, manifest, and license. At process startup Cyberful verifies the compressed digest, restores the database into the Cyberful cache under a directory named by `snapshot_id`, verifies the uncompressed size and SHA-256, and atomically installs the complete directory. A missing or corrupted materialization is rebuilt from the binary. The MCP independently checks the database size, digest, schema, and read-only mode when it opens each phase-local server.

No runtime component contains an ATT&CK HTTP client, TAXII client, update check, or online fallback. If the embedded payload or local database cannot be verified, every data action returns `DATASET_UNAVAILABLE`.

## MCP contract

The internal stdio server publishes one tool, `mitre_attack`, in every Pentest, Bug Bounty, Code Audit, and Ask phase.

The tool schema is a five-branch discriminated `oneOf`. Each branch advertises and accepts only the fields executable for that action; required fields, defaults, descriptions, and numeric bounds therefore reach the provider without relying on prose or model inference.

| Action          | Required input       | Optional input and contract                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`        | none beyond `action` | Return readiness, release versions for every domain, Cyberful build identity, digests, and provenance. No other field is accepted.                                                                                                                                                                                                                                                                                                                                             |
| `search`        | `query`              | `domains`, `object_types`, `tactics`, `platforms`, `include_revoked`, `include_deprecated`, `cursor`, and `limit` from 1 to 100. Search tokens are combined with AND; every supplied tactic and platform must match. A cursor is valid only with the identical normalized query, filters, and limit.                                                                                                                                                                           |
| `get`           | 1–20 `identifiers`   | Optional `domains`. Resolve exact ATT&CK IDs or STIX IDs. Exact lookup includes matching revoked and deprecated objects so callers can inspect their flags.                                                                                                                                                                                                                                                                                                                    |
| `relationships` | 1–20 `identifiers`   | Optional `domains`, `direction`, `relationship_types`, `include_indirect`, `include_revoked`, and `limit` from 1 to 500. Every filter applies to returned relationships. Indirect traversal is an outgoing group → software → technique path labeled `uses-via-software`; selecting that synthetic relationship type returns only indirect paths. Endpoint objects remain domain-affined and `endpoints_truncated` reports when the bounded endpoint projection is incomplete. |
| `matrix`        | one `domain`         | Optional exact `platform`, `tactics`, revoked/deprecated flags, and per-tactic `limit` from 1 to 50, default 5. Tactic selectors accept ATT&CK IDs, STIX IDs, or exact short names. Each tactic reports its complete count and explicit truncation state so callers can narrow and continue with `get`.                                                                                                                                                                        |

The supported records are tactics, techniques and sub-techniques, software, groups, and their relationships. Results include ATT&CK and STIX IDs, domain, object and STIX type, name, bounded description, aliases, tactics, platforms, official URL, dates, sub-technique, revoked/deprecated state, and snapshot identity. Search returns at most 100 records, exact lookup accepts at most 20 identifiers, relationships return at most 500 records, endpoint projections contain at most 20 domain-affined objects, and each matrix tactic returns at most 50 technique records with `total_techniques` and `truncated` fields. There are no embeddings, LLM-generated mappings, unbounded lists, or runtime downloads.

## Agent policy and durable assessment

Agents load `operate-mitre-attack` when adversary behavior is relevant and use the MCP rather than training knowledge for ATT&CK facts. The skill carries valid payload examples for every action, explains search and traversal semantics, distinguishes `INVALID_REQUEST` from dataset unavailability, and directs broad matrix exploration toward tactic filters and exact lookup. Brief or Scope records the likely domain and applicability. Research phases use tactics, techniques, groups, software, and relationships to generate and organize hypotheses. Exploit, Hacker, and Code Audit Attack use the matrix to expand chains while deliberately searching outside it. ATT&CK coverage and vulnerability coverage are independent.

New hypotheses begin with `applicability: UNASSESSED`. The hypothesis tool can record `APPLICABLE`, `NOT_APPLICABLE`, or `UNAVAILABLE`, a rationale, proposed mappings, and evidence references. Promotion copies that assessment into the finding registry. Phase-derived `hypothesis` and `finding` schemas expose only `NOT_REVIEWED` outside Verify; Verify alone receives `ACCEPTED`, `REVISED`, and `REJECTED` after re-querying the same snapshot. Report publishes only accepted or revised mappings.

The host intentionally does not check the existence of an agent-declared ID during registry writes, require proof of an earlier MCP call, or block handoff because a mapping is absent. Those would turn framework procedure into a brittle authority boundary. The build validates static routing metadata; agents and Verify own evidence-backed case-specific associations.

`NOT_APPLICABLE` is neutral. It never lowers severity, confidence, reward potential, priority, finding promotion, handoff, or report eligibility. Business-logic flaws, IDOR root causes, CWE/OWASP classes, parser defects, generic Firefox bugs, zero-days, novel primitives, and new exploit chains remain first-class even without an ATT&CK mapping. Credential stuffing or another behavior receives a mapping only when the observed mechanism supports it. A mapping is context and never proof that a vulnerability exists.

## Licensing

Cyberful preserves the exact MITRE copyright designation and license acquired with the build in the snapshot, runtime cache, and platform-neutral archive. `THIRD_PARTY_NOTICES.md` records the attribution, and the snapshot SPDX document describes each domain package and source digest. ATT&CK® is a registered trademark of The MITRE Corporation.
