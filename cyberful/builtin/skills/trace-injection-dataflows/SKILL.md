---
name: trace-injection-dataflows
description: Trace and test untrusted data through SQL, NoSQL, LDAP, XPath, XML, shell, process, template, expression-language, code-evaluation, log, spreadsheet, mail, header, and browser interpreters. Use for injection vulnerability research, taint analysis, source review, parser-confusion analysis, sanitizer validation, or proving whether data reaches an executable or structurally significant sink.
---

# Trace Injection Dataflows

Injection exists when attacker-influenced data changes structure or execution in an interpreter. Validation failure without interpreter influence is not sufficient.

## Define source and sink semantics

Identify source provenance, attacker capability, encoding, parser, transformations, storage, trust changes, and the exact interpreter grammar at the sink. Read [references/interpreter-catalog.md](references/interpreter-catalog.md) for sink-specific invariants.

Trace both forward from sources and backward from sinks:

`source -> decode/canonicalize -> validate -> transform -> store -> retrieve -> encode/parameterize -> interpreter -> effect`

Include second-order data, batch jobs, logs later parsed by tools, templates stored then rendered, queue messages, imported files, plugin metadata, and administrator-facing workflows.

## Prove control dominance

Determine whether parameterization, safe API, allowlist, contextual encoding, typed builder, sandbox, or structural separation dominates every reachable path. A sanitizer is valid only for the exact interpreter context and after the final decoding or canonicalization step.

Read [references/taint-proof.md](references/taint-proof.md) for audit and evidence rules.
Use [references/field-heuristics.md](references/field-heuristics.md) for multi-parser, second-order, identifier, and blind-flow differentials.

## Test minimally

Use syntax-neutral markers, paired valid/invalid structures, type changes, or safe expression effects before any high-impact payload. Observe query plan, parsed structure, rendered context, child-process argv, log fields, or other ground truth when available. Avoid extracting real data or executing destructive commands.

For blind claims, require a discriminating timing or OAST control tied to a unique token and authorized infrastructure. A generic error, status change, reflection, or latency spike is a lead.

## Handle parser differentials

Compare client, gateway, framework, application, library, database, shell, template, and downstream parser behavior for duplicate fields, encodings, Unicode, nulls, separators, comments, quoting, numeric forms, media types, and normalization. Validate after canonicalization and before interpretation.

## Audit remediation

Prefer structural APIs: prepared statements, typed query builders, argument arrays, fixed templates, safe renderers, schema-bound serialization, structured logging, and explicit protocol libraries. Allowlists constrain identifiers or operations that cannot be parameterized. Escaping is context-specific and usually a last boundary control.

## Confirmation standard

Record source, full data path, interpreter and grammar context, failed control, safe control case, observable structural or execution effect, attacker capability, and affected authority. Scope systemic findings to shared unsafe helpers only after proving their callers and contexts.

## Authoritative anchors

- OWASP Injection Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Injection_Prevention_Cheat_Sheet.html
- OWASP Query Parameterization Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Query_Parameterization_Cheat_Sheet.html
- CWE-74 Injection: https://cwe.mitre.org/data/definitions/74.html
