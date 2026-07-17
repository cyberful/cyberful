# Cryptographic and Key Review

## Construction Checklist

Prefer authenticated encryption for confidentiality plus integrity. Verify nonce uniqueness rules, tag verification before plaintext use, associated-data coverage, maximum message limits, and failure behavior.

For signatures and MACs, bind protocol, tenant, object type, purpose, algorithm, key version, subject, audience, and freshness into an unambiguous canonical representation. Reject algorithm or key selection controlled by untrusted data unless constrained by the verifier.

For password storage, verify a memory-hard password KDF with calibrated cost, unique salts, optional pepper separation, rehash-on-login migration, maximum input handling, and resistance to user enumeration.

## Randomness and Uniqueness

Distinguish unpredictability from uniqueness. Review CSPRNG use, seed source, process fork behavior, VM snapshot and restore, deterministic test overrides, distributed counter allocation, truncation, and collision handling.

UUID presence alone proves neither secrecy nor authorization.

## Key Lifecycle

Map generation, import, wrapping, storage, access policy, caching, exportability, replication, versioning, rotation, compromise recovery, backup, and destruction. Separate encryption keys, MAC keys, signing keys, password peppers, token keys, and key-encryption keys by purpose and environment.

Confirm which component sees plaintext keys and whether a KMS or HSM policy actually restricts operations rather than merely storing bytes.

## Protocol and Implementation Traps

- Encrypt-then-sign or sign-then-encrypt claims are ambiguous unless exact framing and verification order are defined.
- Canonicalization differences create signature bypasses or cross-language verification failures.
- Decryption errors, padding errors, parsing errors, and timing can form an oracle even behind a generic HTTP status.
- Nonce counters can repeat after rollback, cold restore, cloning, or blue/green deployment.
- Key rotation can accept old artifacts indefinitely if version and issuance time are not enforced.
- Deterministic encryption leaks equality and frequency; this may violate the actual property even when the primitive is strong.
- Truncated MACs require a quantified forgery budget that includes online rate and artifact lifetime.

## Transport

Review effective TLS protocol and cipher negotiation, certificate and hostname verification, trust stores, client certificates, proxy interception, downgrade paths, redirect behavior, HSTS scope, internal service TLS, and certificate rotation. A secure external edge does not imply secure service-to-service transport.
