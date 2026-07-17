---
name: operate-metasploit
description: Operate Metasploit as an evidence-led validation framework during authorized network, service, and application assessments. Use when a fingerprinted product or protocol maps to a Metasploit auxiliary, exploit, payload, post, encoder, evasion, or RPC workflow; when checking module applicability; or when converting a manual hypothesis into a reproducible module run.
---

# Operate Metasploit

Use Metasploit to test a specific hypothesis, not to substitute for reconnaissance. Tie every module choice to observed product, version, configuration, reachability, and architecture evidence.

## Build the module decision

1. Normalize the candidate into service, product, version/build, platform, architecture, authentication state, exposure path, and suspected weakness.
2. Search by CVE, product, protocol, module rank, and disclosure date. Read module metadata and references before selecting it.
3. Inspect show options, show advanced, show missing, targets, payload constraints, notes, side effects, and check support.
4. Read the module source when applicability, target matching, cleanup, or success conditions are ambiguous.
5. Record why the chosen module is a better discriminator than a manual probe or a narrower auxiliary module.

Read [references/module-field-manual.md](references/module-field-manual.md) for target-resolution, datastore, handler, session, and failure-analysis heuristics.

## Separate the four runs

- **Applicability:** version/configuration evidence and check where implemented.
- **Reachability:** auxiliary scanner or a minimally expressive request proves the vulnerable path is reachable.
- **Effect:** the smallest module action that demonstrates the security boundary crossing.
- **Impact:** only the additional action needed to establish material consequence, using engagement-owned artifacts and reversible state.

Never treat "check: appears" as exploitation, a handler connection as the intended target, or "exploit completed" as success without the module's concrete success signal.

## Prefer deterministic console batches

Use msfconsole with -q -x for bounded, reviewable batches. Include:

1. use module;
2. explicit set statements for every target-dependent value;
3. show options or show missing;
4. check when meaningful;
5. the selected run command;
6. session/job inspection;
7. cleanup and exit.

Do not depend on stale global datastore values. Use unsetg all in isolated reproductions, and capture setg only when deliberately sharing values across modules.

## Select payloads from constraints

Derive payload family from transport reachability, target architecture, execution context, staging reliability, available interpreters, and required evidence. Prefer payloads that minimize moving parts:

- command payload for a single observable effect;
- non-staged payload when staging transport is unreliable or prohibited;
- bind versus reverse only after checking route direction and egress;
- architecture-specific payload only after confirming process architecture, not host branding;
- handler-free proof when callback infrastructure adds no evidentiary value.

Distinguish target process architecture, operating-system architecture, container architecture, and compatibility layer. A 64-bit host can expose a 32-bit service.

## Interpret outcomes

Classify a run as:

- NOT_APPLICABLE: strong version/configuration mismatch;
- NOT_REACHABLE: route, protocol, virtual-host, TLS, proxy, or authentication mismatch;
- INCONCLUSIVE: module assumptions or target stability prevent discrimination;
- LIKELY_VULNERABLE: check or protocol evidence matches without effect proof;
- CONFIRMED: repeatable target-side effect tied to the exact request/module path;
- ENVIRONMENTAL_FAILURE: handler, payload, dependency, database, or local routing failure.

One negative module run is not a negative vulnerability result. Before closing, inspect target selection, module age, check implementation, datastore inheritance, network path, WAF/proxy transformations, crash-only behavior, and patched-but-version-unchanged builds.

## Preserve evidence

Save module fullname, rank, source revision/package version, target index, payload, non-secret datastore values, exact console batch, timestamps, target response, session/job state, and cleanup result. Redact credentials from narrative output while retaining their source and privilege class in the evidence ledger.

## Handoff

Report:

- hypothesis and preconditions;
- why this module/target/payload fits;
- exact commands and observable signals;
- alternate explanations eliminated;
- state created and removed;
- residual uncertainty and the best next discriminator.
