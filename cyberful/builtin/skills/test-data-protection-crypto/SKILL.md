---
name: test-data-protection-crypto
description: Assess sensitive-data lifecycle, secret handling, cryptographic design and implementation, key management, password storage, randomness, signing, encryption, transport protection, and side channels during authorized penetration tests or code audits. Use for data exposure, hardcoded secrets, weak cryptography, token forgery, nonce misuse, key rotation, TLS, backup, log, export, deletion, and privacy-boundary review.
---

# Test Data Protection and Cryptography

## Start From Data and Security Properties

Inventory sensitive data and derived identifiers across collection, transit, processing, memory, storage, cache, logs, analytics, exports, backups, support tools, replicas, and deletion. Record owner, tenant, readers, writers, retention, residency, and the consequence of disclosure, modification, replay, rollback, or unavailability.

Define the required property before evaluating an algorithm: confidentiality, integrity, authenticity, freshness, unlinkability, forward secrecy, password-hardening, or non-repudiation. Encryption is not a substitute for authorization, and signing is not a substitute for freshness or context binding.

Read [data-lifecycle.md](references/data-lifecycle.md) for exposure analysis. Read [cryptographic-review.md](references/cryptographic-review.md) for primitive, protocol, and key review.

## Build the Cryptographic Dataflow

For every protected value, trace:

1. plaintext origin and canonical representation;
2. algorithm, mode, parameters, and library;
3. key derivation, location, purpose, version, and access path;
4. nonce, IV, salt, sequence, or counter generation;
5. associated data and context binding;
6. encoding, framing, and transport;
7. verification or decryption order and error behavior;
8. rotation, migration, revocation, recovery, and destruction.

Review call sites, not only wrappers. A secure wrapper can be bypassed by legacy helpers, configuration fallbacks, or manual encoding.

## Verify With Properties and Test Vectors

Use known-answer tests, boundary inputs, duplicate operations, corrupted fields, wrong context, wrong key version, reordered messages, stale artifacts, and restart behavior. Search for nonce reuse across process forks, replicas, retries, backups, and counter resets.

Measure timing only with sufficient repeated samples and matched controls. Prefer a code-level proof when a variable-time secret comparison or padding oracle is directly visible.

## Separate Exposure From Exploitability

Classify exposed material precisely: public identifier, personal data, authentication secret, service credential, key-encryption key, signing key, recovery material, or encrypted blob with accessible keys. Establish actual access path and retention.

Do not inflate a version string or disabled legacy cipher into a critical finding without a negotiated or reachable path.

## Produce an Architectural Fix

State the failed property, cryptographic boundary, key scope, affected data, and rotation implications. Recommend well-reviewed high-level constructions, purpose-separated keys, explicit versioning, authenticated framing, controlled secret stores, and migration that handles existing ciphertext and tokens.
