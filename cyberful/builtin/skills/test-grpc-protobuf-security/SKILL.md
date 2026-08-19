---
name: test-grpc-protobuf-security
description: Test authorized gRPC and protobuf services for metadata, identity, authorization, reflection, transcoding, streaming, parser, and resource-boundary failures. Use for native gRPC, grpc-web, protobuf RPC, and gateway-backed service assessments.
metadata:
  domain: application-security
  subdomain: grpc-protobuf-security
  triggers:
    - test gRPC security
    - protobuf RPC assessment
    - gRPC metadata authorization
    - gRPC reflection exposure
    - grpc-web security test
  tags:
    - gRPC
    - protobuf
    - RPC
    - streaming
    - metadata
    - parser
  frameworks:
    mitre_attack:
      - T1190
    nist_csf:
      - PR.AA
---

# Test gRPC and Protobuf Security

Treat every RPC method, message field, metadata value, stream transition, and transcoding route as a separate authority and parser boundary. Confirm declared descriptors against the deployed service; reflection may be incomplete, disabled, or broader than published contracts.

Read [grpc-protobuf-testing.md](references/grpc-protobuf-testing.md) before testing streaming, oneof/presence semantics, unknown fields, or gateway differentials.

For bounded unary probes in Pentest or Bug Bounty, stage [scripts/run_grpc_protobuf_probe.py](scripts/run_grpc_protobuf_probe.py), its [manifest](scripts/manifest.json), and the [example](assets/grpc-protobuf-probe.example.json). The helper invokes fixed `grpcurl`, accepts campaign constraints rather than authority, resolves secrets only from `CYBERFUL_GRPC_AUTHORIZATION` after preflight, and cannot select proxy or trust through JSON. Literal loopback connects directly; non-loopback origins require Cyberful's runtime proxy and CA bundle. It is unavailable for Code Audit target traffic.

## Test differentials

Compare low/high privilege and cross-tenant identities against the same method and message. Exercise absent versus default scalar presence, oneof alternatives, repeated/map bounds, enum unknowns, `Any`, field masks, deadlines, cancellation, compression, metadata duplication, streaming order, and REST transcoding only where each case remains bounded.

Report a finding only when the minimal control/candidate pair demonstrates an authorization, integrity, confidentiality, or availability invariant failure. Preserve descriptor version, full method, metadata names, redacted request, status/trailers, and downstream effect.
