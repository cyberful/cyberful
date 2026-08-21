---
name: test-ai-tool-authorization
description: Test deterministic authorization around AI tool discovery, selection, canonical arguments, credentials, tenants, destinations, approvals, delegation, retries, and effects. Use when model refusal is insufficient and the host or gateway must enforce an authorized capability boundary.
metadata:
  domain: ai-security
  subdomain: tool-authorization
  triggers:
    - test AI tool authorization
    - agent capability boundary
    - MCP tool authorization
    - tool approval binding
    - delegated agent authority
  tags:
    - tool-calling
    - authorization
    - MCP
    - approvals
    - canonicalization
    - least-privilege
  frameworks:
    nist_csf:
      - PR.AA
    nist_ai_rmf:
      - MEASURE 2.7
---

# Test AI Tool Authorization

Treat authorization as a host decision over a canonical action. Model refusal, hidden instructions, and tool descriptions are not enforcement.

## Build the action matrix

Record actor, tenant, session, model route, tool identity/schema, requested arguments, resolved resource, destination, credential, approval, effect, retry/delegation context, and expected decision. Read [references/tool-authorization-matrix.md](references/tool-authorization-matrix.md) for negative cases.

Stage [scripts/run_tool_authorization_probe.py](scripts/run_tool_authorization_probe.py), its [manifest](scripts/manifest.json), and the [probe example](assets/tool-authorization-probe.example.json) for matched allowed/denied HTTP actions. Its JSON carries defense-in-depth campaign constraints, never authority. Actual authorization and non-loopback routing stay in Cyberful's mission-bound gateway or ZAP route, using only runtime standard proxy and CA environment. Reflected credentials are redacted before cumulative-bounded evidence is retained.

## Confirm the enforcement gap

Compare canonical action and external effect, not response prose. Test resource, tenant, destination, recipient, amount, scope, credential, approval freshness, retry, fallback, and delegation boundaries using tester-owned fixtures. Report the smallest unauthorized effect, the missing enforcement owner, control comparison, and cleanup.
