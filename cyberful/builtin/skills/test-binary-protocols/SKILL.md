---
name: test-binary-protocols
description: Build bounded corpora, mutations, handshakes, timing controls, and differential tests for binary, stateful, appliance, or undocumented protocols.
metadata:
  domain: application-security
  subdomain: binary-protocols
  triggers:
    - binary protocol testing
    - stateful protocol fuzzing
    - undocumented protocol
    - appliance protocol
    - protocol framing
    - protocol timing differential
  tags:
    - binary-protocol
    - state-machine
    - framing
    - corpus
    - differential-testing
    - boofuzz
  frameworks:
    mitre_attack:
      - T1190
    nist_csf:
      - ID.RA-01
---

# Test Binary Protocols

Start from one authorized endpoint and an observed valid exchange. Preserve framing, state, authentication context, transport, and timing before mutating fields.

## Build a protocol contract

Document message direction, framing, lengths, checksums, encoding, compression, correlation identifiers, state transitions, retry behavior, authentication, response oracle, traffic ceiling, and cleanup. Import an exact request exported from ZAP with `protocol_campaign import_zap_request` when HTTP carries the protocol.

## Seed and mutate deliberately

Use `build_corpus` for valid minimal states and `mutate` for a small discriminating set. Prefer one semantic mutation at a time: length/value disagreement, signedness, truncation, duplicate field, state reordering, boundary count, invalid enum, compression mismatch, or encoding differential. Use boofuzz only with explicit session, connection, mutation, timeout, and request limits; a campaign without a state model and oracle is incomplete.

Use `zgrab2` for bounded unauthenticated handshakes and fingerprint evidence, not broad Internet scanning. Correlate banners and behaviors with `appliance_fingerprint` and firmware version markers without treating a string match as a proven version.

## Require controls and stable oracles

Pair every candidate with a valid control and a benign near-miss. For latency claims use `paired_timing` with interleaved control/candidate samples, then `classify_anomaly`; never infer a vulnerability from one slow response. Remote timing must traverse the host-owned proxy. Stop on rate limiting, instability, unsafe side effects, or a mission boundary.

## Deliver

Call `protocol_campaign stop` after preserving captures. Record endpoint, request hash, state, corpus, mutations, sample order, traffic count, responses, timing distribution, controls, anomaly classification, cleanup, and exact evidence paths. Promote only effects that survive a repeated differential and exclude the benign explanation.
