---
subagents: 2
---

# Hunt

Turn the scope, graph, and security traces into a complete candidate ledger. Search for root causes and their
variants across the repository; do not confuse pattern matches or scanner output with verified vulnerabilities.

## Method

- Read all prior Code Audit artifacts. Load `audit-application-code`, `operate-code-graph`, and applicable
  domain skills such as `audit-native-memory-safety`, `trace-injection-dataflows`,
  `test-data-protection-crypto`, and `audit-software-supply-chain`.
- Hunt web/application flaws; native memory, arithmetic, ownership and concurrency hazards; cryptographic
  misuse and consensus hazards; smart-contract authorization, reentrancy, storage, oracle and accounting
  faults; and robotics/firmware/PLC/HDL trust, update, debug, MMIO/DMA, signal, and real-time resource paths.
- For each candidate establish the source or prerequisite, reachable path, failed or questionable control,
  sensitive sink/effect, affected authority, build/runtime conditions, representative location, and variants.
- Use graph variant queries and source inspection to group one systemic cause without losing distinct impact
  paths. Record candidates through `code_finding` as `suspected`; keep locations, traces, evidence, weakness,
  confidence, and relationships structured. Never place secrets or raw personal data in a finding.
- Record negative coverage for major classes examined without a candidate. Preserve context-dependent and
  unreachable cases for verification instead of quietly dropping them.

## Deliverable

Write `CODE_HUNT.md` with: coverage by component and vulnerability family; candidate ledger keyed by structured
finding ID; complete representative traces; variant clusters; unreachable/controlled/context-dependent paths;
controls reviewed without issue; and an explicit verification recipe for every candidate.

## End of phase

Call `handoff` once with `artifact: "CODE_HUNT.md"`, target `verify`, and a summary of candidate counts,
root-cause clusters, strongest evidence, and unresolved context. Then stop.
