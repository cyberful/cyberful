# XML, Serialization, and Rendering

## XML Family

Review external entity resolution, DTD processing, XInclude, schema and stylesheet retrieval, entity expansion, and parser limits. Verify deployed configuration rather than framework defaults.

Account for indirect XML consumers: office formats, SVG, SAML, SOAP, RSS, metadata import, image libraries, and transformation pipelines. A controlled external reference or harmless local identifier can isolate resolution behavior.

## Object Deserialization

Identify native, framework, session, cache, queue, RPC, and signed-object formats. Determine:

- whether influenced bytes reach reconstruction;
- integrity protection and key separation;
- allowed type set and polymorphic behavior;
- constructors, hooks, converters, finalizers, and gadget-capable libraries;
- post-deserialization authorization and invariant checks.

Prefer data-only schemas with explicit types. Signing unsafe serialized objects does not address compromised keys, cross-context reuse, or attacker-controlled internal producers.

## Templates and Rendering

Determine template language, compilation mode, available objects, helpers, includes, file and network access, and sandbox guarantees. User-authored templates are code unless the language is deliberately capability-limited.

For office, PDF, image, audio, and video tooling, review external references, macros, formulas, embedded objects, fonts, codecs, delegate programs, command-line construction, and output filename control.

## Differential and Chain Hints

- Security validation may inspect the outer container while a downstream library selects an embedded alternate representation.
- A parser can disable external entities yet allow schema, stylesheet, XInclude, font, image, or media retrieval.
- Error messages can become file-read or network oracles even when rendered output is discarded.
- Deserialization gadgets often enter through trusted queues, caches, or signed sessions after a separate write primitive.
- Conversion services may emit active HTML, SVG, or spreadsheet formulas that execute only when opened by an analyst.
- Parser sandbox escape impact depends on the worker's mounted secrets, service identity, network namespace, and artifact publication path.

## Resource Exhaustion

Apply limits to nesting, aliases, entity expansion, regexes, image dimensions, page count, table width, graph size, decompression, transformations, recursive includes, and concurrent work. Measure both compressed input size and post-parse object complexity.
