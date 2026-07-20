---
subagents: 2
---

# Hunt

Turn the scope, graph, threat model, control traces, and supply-chain map into a complete candidate ledger.
Search for root causes and variants across the repository; scanner output and suspicious syntax are leads,
not vulnerabilities.

## Method

- Read all prior Code Audit artifacts. Load `audit-application-code`, `operate-code-graph`, and applicable
  domain skills such as `audit-native-memory-safety`, `trace-injection-dataflows`,
  `test-data-protection-crypto`, and `audit-software-supply-chain`.
- Hunt identity, session, authorization, tenant, business-invariant, parser, injection, SSRF, browser, API,
  privacy, resource-amplification, and agentic-AI flaws; native memory, arithmetic, ownership and concurrency hazards; cryptographic
  misuse and consensus hazards; smart-contract authorization, reentrancy, storage, oracle and accounting
  faults; dependency confusion, lifecycle/build/CI/cache/artifact/promotion trust breaks; cloud/deployment
  misconfiguration; and robotics/firmware/PLC/HDL trust, update, debug, MMIO/DMA, signal, and real-time paths.
- For each candidate establish the source or prerequisite, reachable path, failed or questionable control,
  sensitive sink/effect, affected authority, build/runtime conditions, representative location, and variants.
- Use graph variant queries and source inspection to group one systemic cause without losing distinct impact
  paths. Record candidates through `code_finding` as `suspected`; keep locations, traces, evidence, weakness,
  confidence, and relationships structured. Never place secrets or raw personal data in a finding.
- Challenge architecture claims and framework defaults at their concrete enforcement points. For diff audits,
  review every changed security-sensitive line plus the graph-derived blast radius and plausible alternate paths.
- Record negative coverage for major classes examined without a candidate. Preserve context-dependent and
  unreachable cases for verification instead of quietly dropping them.

## Deliverable

Write `CODE_HUNT.md` with: coverage by component and vulnerability family; candidate ledger keyed by structured
finding ID; complete representative traces; variant clusters; unreachable/controlled/context-dependent paths;
controls reviewed without issue; and an explicit verification recipe for every candidate.

## End of phase

Call `handoff` once with `artifact: "CODE_HUNT.md"`, target `attack`, and a summary of candidate counts,
root-cause clusters, strongest evidence, executable hypotheses, and unresolved context. Then stop.
