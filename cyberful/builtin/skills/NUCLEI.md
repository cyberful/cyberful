---
name: NUCLEI
description: Select, preview, plan, and run ProjectDiscovery Nuclei safely through cyberful-os, including the controlled plan/execute path and the existing raw and template-inspection tools.
keywords:
  - nuclei
  - nuclei_plan
  - nuclei_run_scoped
  - nuclei_templates
  - template scanner
  - cve scanner
  - projectdiscovery
---

# Nuclei

Nuclei is a candidate-validation accelerator, not broad reconnaissance and not a confirmation engine. Use it
after the target has supplied a concrete technology, version, endpoint class, or vulnerability hypothesis.
Every match remains `SUSPECTED` until a minimal independent reproduction and a benign control distinguish the
claimed mechanism from scanner noise.

## Choose the right cyberful-os tool

cyberful-os exposes four complementary Nuclei tools. The two controlled tools are additions; they do not replace
the existing expert surface.

- `nuclei_plan` is the preferred starting point. It accepts one authorized HTTP or HTTPS target plus structured
  `tags`, `template_ids`, or `severities`. It performs only an offline template listing, refuses an unfiltered
  selection, refuses more than 40 matched templates, caps the planned rate at 5 requests/second, and returns an
  opaque one-use plan ID. Planning sends no target traffic.
- `nuclei_run_scoped` executes exactly the stored plan. It accepts no raw flags and fixes concurrency and bulk
  size to 1, rate to at most 5 requests/second, `X-Request-ID: Bugcrowd`, update checks off, redirects off, OAST
  off, and intrusive tags excluded. It writes JSONL evidence under `raw/operations/nuclei/`.
- `nuclei_templates` is the existing side-effect-free expert preview. Use it to understand how a raw
  `-tags`/`-id`/`-severity` expression maps to the installed signed corpus. It lists templates but creates no
  plan and sends no target request.
- `nuclei` is the existing raw CLI wrapper. Keep it for justified cases the controlled planner cannot express.
  It does not inherit the planner's guarantees, so the caller must supply the marker, rate, concurrency,
  no-update, no-OAST, exclusion, and narrow-filter flags explicitly. Never run it unfiltered.

`tool_inventory` explains every wrapper and its underlying command. `capability_attestation` checks the live
image against the complete CLI/library catalog and smoke-tests Nuclei and Metasploit without target traffic.
An unavailable or degraded required capability is a platform blocker, not permission to improvise a hidden
install or download templates during an engagement.

## Preferred workflow

1. Call `nuclei_plan` only when the candidate and expected request cost justify a scan, using the narrowest
   tags or exact IDs supported by observed evidence. Treat a zero-match
   or over-budget plan as feedback to refine the hypothesis, not as a reason to broaden blindly.
2. Review the returned target, filter, template list, request rate, and output path. If any differs from the
   intended scope, discard it and plan again.
3. Call `nuclei_run_scoped` once with only the plan ID. A challenge page, `403`, or `429` ends that scanner
   run and is evidence about its requests, not a phase-wide stop. Do not retry or disguise the rejected run;
   continue only independent authorized work while the target is stable. Stop all target traffic for an
   explicit mission stop condition, scope uncertainty, systemic instability, unexpected private data, or an
   unplanned side effect.
4. Reproduce each useful match with the smallest direct request and a control. Save only redacted durable
   evidence. Record false positives and zero-hit runs too; they are tool-utility data, not vulnerabilities.

## Raw-wrapper discipline

Use `nuclei_templates` before raw `nuclei`, passing the same filter flags. Keep the selection in the low tens.
The raw run must include explicit technology/ID/severity filters, `-disable-update-check`, `-no-interactsh`,
`-rate-limit 5`, `-c 1`, `-bulk-size 1`, and `-H "X-Request-ID: Bugcrowd"`. Exclude DoS, fuzzing, brute-force,
headless, OAST/interactsh, and intrusive templates unless the engagement has separately approved the exact
behavior. Do not add remote template URLs, update the corpus, or treat a successful process exit as a finding.

## Phase use

- Recon may preview or plan from a concrete fingerprint, but target scanning must remain within its traffic and
  mission policy. Broad "scan everything" behavior is not Recon coverage.
- Exploit uses controlled plans to test a specific Recon candidate, then confirms or disproves it manually.
- Hacker uses Nuclei only for a new concrete chain component, not to repeat systematic coverage.
- Verify replays the final minimal proof and control; it does not accept Nuclei JSONL as verification by itself.
- Report reads the preserved evidence and `raw/operations/tool-usage.csv`; it sends no Nuclei traffic.

The CSV is host-owned and local to the workarea. It records actual tool calls, duration, outcome, output size,
marker attestation, and finding counts when supplied. It never records tool arguments, URLs, headers, bodies,
cookies, or tokens and emits no telemetry.
