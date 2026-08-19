# Built-in skill catalog

Cyberful ships exactly 106 first-party skill packages for authorized Pentest, Bug Bounty, and Code Audit work. They are original Cyberful procedures rather than imported copies of an external skill collection. Broad packages route to narrow specialists; each specialist owns one operational intent, evidence contract, and completion boundary.

## Operational taxonomy

Every first-party name begins with one closed intent prefix. The prefix explains what kind of work the package performs; it never grants authorization, target access, a tool, or a network route.

| Prefix | Meaning |
| --- | --- |
| `test-` | Seek and demonstrate a vulnerability or security-invariant violation. |
| `audit-` | Examine source, configuration, architecture, or an implementation contract. |
| `trace-` | Reconstruct a causal path, identity propagation, state transition, or dataflow. |
| `analyze-` | Transform supplied artifacts into bounded evidence, normally offline. |
| `operate-` | Use a concrete tool or toolchain under its declared operating contract. |
| `assess-` | Coordinate several analysis modes into a broad evaluation. |
| `plan-` | Prepare authorization, scope, strategy, and coverage before testing. |
| `report-` | Assemble reviewed evidence into a versioned draft deliverable without granting attestation authority. |

The package frontmatter adds a domain, subdomain, four to eight canonical triggers, discriminating tags, and only relevant framework mappings. `skill_search` queries the complete in-memory index across those fields even when the initial prompt contains only a compressed excerpt.

## Progressive loading

The immutable system message always contains every skill name grouped by category without a host path. That name index is lossless and intentionally outside the descriptive budget. Descriptions, categories, triggers, XML wrappers, and escaping share `agent.skill_catalog.description_budget_percentage`, which defaults to 2% of the effective route's immutable operational context window at four serialized characters per token.

At the 256K operational default, the charged metadata budget is 5,120 tokens or 20,480 characters. The compact category serialization keeps a coherent excerpt of at least 64 characters for every built-in package. Smaller windows may degrade deterministically to name-only entries without reducing `skill_search` coverage.

Selection follows one fixed sequence:

1. Call `skill_read` directly when the exact relevant name is already unequivocal; otherwise use `skill_search` and its stable cursor.
2. Read the selected `SKILL.md` completely before applying the procedure. Only this complete read increments `skillsUsed`.
3. Read focused references only when the procedure routes to them.
4. If the procedure needs a packaged script or asset, call `skill_stage` after the complete instruction read. Staging returns a content-addressed workarea path, byte count, and SHA-256 digest without exposing the host package path.
5. Pass the staged workarea resource to the eligible shell, lab, or runtime tool. Search and staging never expand mission authority.

## Package resources

Every package contains `SKILL.md`, `agents/openai.yaml`, and focused supporting material. References hold detailed decision rules that do not belong in the discovery excerpt. Assets are operational contracts such as schemas, examples, matrices, ledgers, or reusable assessment templates; packages do not add decorative files merely to satisfy a shape.

A package with executable automation also contains one Python entrypoint, `scripts/manifest.json`, strict input and raw-output schemas, a valid packaged example, and tests. The manifest declares class, network mode, workflows, phases, fixed dependencies, effects, deadline, request/concurrency/output limits, environment-secret names, and resource schemas. A target-network manifest additionally declares runtime-owned authorization and either the canonical HTTP-proxy route or the controlled target-network route. Proxy and CA selection never comes from model-authored JSON.

Offline analyzers are deterministic and bounded. Harnesses remain loopback-only where declared. Authorized probes and orchestrators use argv without a shell, fixed commands, explicit child-environment allowlists, global deadlines, process-group cleanup, hard output caps, secret redaction, and raw evidence without an automated vulnerability verdict. Code Audit never receives external target networking.

## Framework snapshots

Mappings are manually maintained against eight pinned official sources. Runtime never downloads or updates a framework, and a skill name alone never justifies a mapping.

| Namespace | Pinned snapshot | Purpose |
| --- | --- | --- |
| MITRE ATT&CK | [19.1](https://attack.mitre.org/resources/versions/) | Adversary behavior and TTPs. |
| NIST CSF | [2.0](https://www.nist.gov/cyberframework) | Organizational cybersecurity outcomes. |
| MITRE ATLAS | [2026.06](https://github.com/mitre-atlas/atlas-data/releases/tag/v2026.06) | AI and machine-learning adversarial techniques. |
| MITRE D3FEND | [1.5.0](https://d3fend.mitre.org/resources/ontology/) | Defensive countermeasure techniques. |
| NIST AI RMF | [1.0](https://www.nist.gov/itl/ai-risk-management-framework) | AI risk governance, mapping, measurement, and management. |
| MITRE F3 | [pinned source revision](https://github.com/center-for-threat-informed-defense/fight-fraud-framework) | Cyber-enabled financial-fraud behaviors. |
| PCI DSS | [4.0.1](https://docs-prv.pcisecuritystandards.org/PCI%20DSS/Standard/PCI-DSS-v4_0_1.pdf) | Payment-card environment scope, penetration testing, segmentation, and evidence readiness. |
| GDPR | [Regulation (EU) 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj) | Data-protection accountability, records, security, impact assessment, and evidence reporting. |

The repository records the official URL, version, and source SHA-256 in `cyberful/builtin/skills/framework-sources.json`. The reviewed, sorted set of identifiers actually used by the catalog is bound to those digests in `cyberful/builtin/skills/framework-identifiers.json`. CI validates metadata syntax, exact mapping membership, package resources, script manifests, schema/example compatibility, and the exact 106-package inventory documented below.

## Complete inventory

The inventory below is generated from the same validated package set used by the runtime. Categories are discovery aids; an engagement should select by the narrowest useful intent and evidence boundary rather than load every related package.

### `plan-` (3)

- `plan-authorized-ai-red-team` — `red-team-planning`
- `plan-authorized-pentest` — `engagement-planning`
- `plan-pci-dss-penetration-test` — `pci-penetration-planning`

### `report-` (1)

- `report-of-compliance` — `compliance-reporting`

### `assess-` (8)

- `assess-ai-system-risk` — `risk-assessment`
- `assess-application-threat-model` — `threat-modeling`
- `assess-embedded-iot-security` — `embedded-iot-assessment`
- `assess-fraud-abuse-model` — `fraud-abuse-modeling`
- `assess-identity-architecture` — `identity-architecture`
- `assess-mobile-security` — `mobile-security`
- `assess-pci-dss-readiness` — `pci-dss-readiness`
- `assess-smart-contract-security` — `smart-contract-assessment`

### `audit-` (20)

- `audit-access-policy-enforcement` — `access-policy`
- `audit-ai-agent-security` — `agent-security-routing`
- `audit-ai-model-supply-chain` — `model-supply-chain`
- `audit-api-contract-implementation` — `api-contract-assurance`
- `audit-application-code` — `application-security-routing`
- `audit-build-release-pipelines` — `build-release-pipelines`
- `audit-cloud-native-security` — `cloud-native-security`
- `audit-container-runtime-isolation` — `container-runtime`
- `audit-database-access-layer` — `database-access`
- `audit-desktop-client-security` — `desktop-client-security`
- `audit-embedded-firmware-security` — `firmware-security-audit`
- `audit-infrastructure-as-code` — `infrastructure-as-code`
- `audit-kubernetes-policy-enforcement` — `kubernetes-policy`
- `audit-native-memory-safety` — `native-memory-safety`
- `audit-pci-dss-penetration-test-evidence` — `pci-penetration-evidence`
- `audit-secrets-management` — `secrets-management`
- `audit-security-logging-telemetry` — `security-telemetry`
- `audit-serverless-security` — `serverless-applications`
- `audit-smart-contract-security` — `smart-contract-code-audit`
- `audit-software-supply-chain` — `producer-to-runtime-assurance`

### `trace-` (10)

- `trace-ai-context-capabilities` — `context-capability-tracing`
- `trace-cardholder-data-environment` — `cardholder-data-environment`
- `trace-distributed-request-causality` — `distributed-causality`
- `trace-file-processing-pipelines` — `file-processing-pipelines`
- `trace-identity-propagation` — `identity-propagation`
- `trace-injection-dataflows` — `injection-dataflows`
- `trace-request-normalization` — `http-normalization`
- `trace-secret-propagation` — `secret-propagation`
- `trace-tenant-context-propagation` — `tenant-context`
- `trace-transaction-state` — `transaction-state-tracing`

### `analyze-` (8)

- `analyze-api-contract-coverage` — `api-contract-evidence`
- `analyze-cloud-control-plane-evidence` — `control-plane-evidence`
- `analyze-crash-exploitability` — `crash-analysis`
- `analyze-fraud-control-evidence` — `fraud-control-evidence`
- `analyze-http-traffic-evidence` — `http-traffic`
- `analyze-network-packet-captures` — `network-captures`
- `analyze-release-security-diff` — `release-security-diff`
- `analyze-scan-findings` — `scan-correlation`

### `operate-` (21)

- `operate-active-directory-toolchain` — `active-directory`
- `operate-binary-analysis-toolchain` — `binary-analysis`
- `operate-browser` — `browser-operations`
- `operate-cloud-posture-toolchain` — `posture-tooling`
- `operate-code-graph` — `code-graph-analysis`
- `operate-content-discovery` — `attack-surface-discovery`
- `operate-evm-security-toolchain` — `smart-contract-tooling`
- `operate-firefox-marionette` — `browser-laboratory`
- `operate-firmware-laboratory` — `firmware-tooling`
- `operate-kubernetes-toolchain` — `kubernetes`
- `operate-metasploit` — `exploit-validation`
- `operate-mobile-instrumentation` — `mobile-instrumentation`
- `operate-native-debugging` — `native-debugging`
- `operate-native-fuzzing` — `coverage-guided-fuzzing`
- `operate-network-recon` — `network-reconnaissance`
- `operate-nuclei` — `dynamic-scanning`
- `operate-sast-toolchain` — `static-application-security-testing`
- `operate-sqlmap` — `sql-injection`
- `operate-supply-chain-toolchain` — `artifact-analysis-tooling`
- `operate-tls-toolchain` — `tls-tooling`
- `operate-zap` — `dynamic-proxy`

### `test-` (35)

- `test-account-recovery-assurance` — `account-recovery`
- `test-ai-prompt-injection` — `prompt-injection`
- `test-ai-tool-authorization` — `tool-authorization`
- `test-api-security` — `api-security-routing`
- `test-authentication-lifecycle` — `authentication-routing`
- `test-authorization-boundaries` — `authorization`
- `test-automated-account-abuse` — `automated-account-abuse`
- `test-binary-protocols` — `binary-protocols`
- `test-browser-messaging-boundaries` — `browser-messaging`
- `test-browser-security` — `browser-security-routing`
- `test-business-logic` — `business-logic-routing`
- `test-cardholder-data-segmentation` — `cde-segmentation`
- `test-concurrency-resource-abuse` — `concurrency-and-resource-abuse`
- `test-data-protection-crypto` — `data-protection-cryptography`
- `test-deserialization-object-binding` — `deserialization-object-binding`
- `test-email-channel-security` — `email-channel-security`
- `test-event-queue-boundaries` — `event-queue-security`
- `test-exposed-services` — `exposed-services`
- `test-federated-identity` — `federated-identity`
- `test-file-parser-security` — `file-parser-security`
- `test-graphql-security` — `graphql-security`
- `test-grpc-protobuf-security` — `grpc-protobuf-security`
- `test-http-intermediaries` — `http-intermediaries`
- `test-identity-linking-provisioning` — `identity-linking-provisioning`
- `test-payment-fraud-controls` — `payment-fraud-controls`
- `test-promotion-entitlement-abuse` — `promotion-entitlement-abuse`
- `test-rag-isolation-integrity` — `rag-isolation-integrity`
- `test-realtime-integrations` — `realtime-integrations`
- `test-server-side-fetching` — `server-side-fetching`
- `test-serverless-event-security` — `serverless-event-security`
- `test-service-workload-identity` — `workload-identity`
- `test-session-security` — `session-security`
- `test-smart-contract-invariants` — `smart-contract-invariant-testing`
- `test-soap-xml-services` — `soap-xml-security`
- `test-web-cache-behavior` — `web-cache-security`
