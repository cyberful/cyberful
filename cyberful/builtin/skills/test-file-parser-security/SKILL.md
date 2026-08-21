---
name: test-file-parser-security
description: Route file-ingestion security work across processing pipelines, deserialization and object binding, and SOAP or XML services. Use for uploads, archives, path handling, document or media transformation, unsafe reconstruction, XML external entities, parser differentials, or parser-isolation questions before selecting the specialist procedure.
metadata:
  domain: application-security
  subdomain: file-parser-security
  triggers:
    - file upload security
    - archive extraction security
    - path traversal
    - unsafe deserialization
    - xxe testing
    - parser differential
  tags:
    - file-upload
    - archive
    - path-traversal
    - deserialization
    - xxe
    - parser-isolation
  frameworks:
    mitre_attack:
      - T1190
      - T1203
    nist_csf:
      - ID.RA-01
      - PR.PS-01
---

# Test File and Parser Security

Use this entrypoint only for triage and shared invariants. Read the selected specialist's `SKILL.md` completely before applying its procedure.

## Route the artifact

- Upload, storage, archive extraction, path resolution, scanners, converters, renderers, derived files, or sandbox transitions: `trace-file-processing-pipelines`.
- Native or language object reconstruction, polymorphic binding, gadget reachability, type selection, or unsafe serializer configuration: `test-deserialization-object-binding`.
- SOAP envelopes, XML schemas, entity resolution, XInclude, XPath, signatures, namespaces, or XML service policy: `test-soap-xml-services`.

If one artifact crosses several boundaries, trace the full processing pipeline first, then invoke the deserialization or SOAP/XML specialist only at the relevant stage.

## Preserve shared invariants

Record the original bytes and hash, accepting interface, content metadata, storage name, canonical resolved paths, every parser and transformation, execution identity, filesystem and network reach, resource limits, derived artifacts, cleanup, and the final consumer. Extension or MIME acceptance is a primitive; confirm what the downstream component actually reads, writes, resolves, fetches, renders, instantiates, or executes.

Use minimal, bounded fixtures and controlled destinations. Stop when a parser becomes unstable, resource ceilings are approached, or the next step would leave authorized storage, filesystem, network, or execution boundaries.
