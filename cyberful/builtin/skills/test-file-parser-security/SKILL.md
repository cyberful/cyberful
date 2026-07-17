---
name: test-file-parser-security
description: Assess file ingestion, archive extraction, path handling, XML and document parsing, media transformation, template rendering, and object deserialization during authorized penetration tests or code audits. Use for upload bypass, path traversal, local or remote file inclusion, Zip Slip, archive bombs, polyglots, XXE, unsafe deserialization, parser differentials, and file-processing sandbox review.
---

# Test File and Parser Security

## Map the Processing Pipeline

Follow the object from acquisition to deletion: upload or fetch, temporary storage, naming, MIME detection, validation, decompression, parsing, transformation, scanning, metadata extraction, rendering, publication, download, backup, and cleanup.

Record every parser and trust transition. A file rejected at the HTTP edge may still be reparsed by a worker; a sanitized image may retain dangerous metadata; a private upload may become public through a derived artifact.

Read [files-archives-paths.md](references/files-archives-paths.md) for storage and extraction. Read [xml-serialization-rendering.md](references/xml-serialization-rendering.md) for active parsers and object reconstruction.

## Derive Parser-Specific Threats

For each stage, identify:

- formats and parser versions;
- size, depth, count, recursion, and time limits;
- external resource resolution;
- executable features, macros, templates, scripts, or formulas;
- path and filename semantics;
- object types or classes instantiated;
- sandbox privileges, network access, and filesystem reach;
- error and derived-output exposure.

Use minimal well-formed probes that isolate one feature. A crash matters when it is reproducible, attributable to a component, and connected to availability or memory-safety impact.

## Separate Acceptance From Impact

Extension or MIME bypass is an input primitive, not the final finding. Prove what the downstream consumer does: execute, render active content, overwrite a path, disclose data, perform a fetch, exhaust resources, or instantiate unsafe code.

A traversal is confirmed when the normalized resolved path crosses the intended root or selects an unintended object-not when a string merely contains dot segments.

## Review Parser Isolation

Verify least-privilege identity, ephemeral or read-only filesystems, absence of ambient secrets, restricted egress, reduced capabilities, resource limits, timeouts, safe temporary-file creation, and cleanup after failure. Treat scanners as additional parsers with their own attack surface and reach.

## Report the Exact Pipeline

Include file structure, accepting stage, parser and version, transformations, resulting capability, privileges, affected artifacts, and deterministic reproduction. Prefer removing dangerous parser features, safe modes, canonical path APIs, and isolation over filename blocklists.
