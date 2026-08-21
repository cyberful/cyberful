---
subagents: 2
---

# Hunt

Turn the scope, graph, threat model, control traces, and supply-chain map into a complete candidate ledger. Search for root causes and variants across the repository; scanner output and suspicious syntax are leads, not vulnerabilities.

Use `operate-mitre-attack` where it helps model adversary behavior, but deliberately hunt zero-days, novel primitives, application-specific root causes, and unexpected compositions outside the framework. Never use the ATT&CK matrix as a completeness checklist or penalize an unmapped candidate.

## Method

- Read all prior Code Audit artifacts. Load `audit-application-code`, `operate-code-graph`, and applicable domain skills such as `audit-native-memory-safety`, `operate-firmware-laboratory`, `operate-sast-toolchain`, `trace-injection-dataflows`, `test-data-protection-crypto`, and `audit-software-supply-chain`.
- Hunt identity, session, authorization, tenant, business-invariant, parser, injection, SSRF, browser, API, privacy, resource-amplification, and agentic-AI flaws; native memory, arithmetic, ownership and concurrency hazards; cryptographic misuse and consensus hazards; smart-contract authorization, reentrancy, storage, oracle and accounting faults; dependency confusion, lifecycle/build/CI/cache/artifact/promotion trust breaks; cloud/deployment misconfiguration; and robotics/firmware/PLC/HDL trust, update, debug, MMIO/DMA, signal, and real-time paths.
- For each candidate establish the source or prerequisite, reachable path, failed or questionable control, sensitive sink/effect, affected authority, build/runtime conditions, representative location, and variants.
- Reopen Trace hypotheses assigned to Hunt. Use graph variant queries and source inspection to group one systemic cause without losing distinct impact paths. Keep speculative paths in `hypothesis`; promote one through `code_finding` as `suspected` only after positive code/context evidence exists, then link its hypothesis with `finding_id`. Never place secrets or raw personal data in either registry.
- Challenge architecture claims and framework defaults at their concrete enforcement points. For diff audits, review every changed security-sensitive line plus the graph-derived blast radius and plausible alternate paths.
- Record negative coverage for major classes examined without a candidate. Preserve context-dependent and unreachable cases by disposition or by queueing them to Attack instead of quietly dropping them.

## Deliverable

Write `CODE_HUNT.md` with: coverage by component and vulnerability family; candidate ledger keyed by structured finding ID; complete representative traces; variant clusters; unreachable/controlled/context-dependent paths; controls reviewed without issue; and an explicit verification recipe for every candidate.

## End of phase

Call `handoff` once with `artifact: "CODE_HUNT.md"`, target `attack`, and a summary of candidate counts, root-cause clusters, strongest evidence, executable hypotheses, and unresolved context. Then stop.
