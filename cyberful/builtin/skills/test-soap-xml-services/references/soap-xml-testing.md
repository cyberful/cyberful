# SOAP and XML Service Testing

Use this reference after the endpoint, operation, SOAP version, and allowed effects are explicit. Preserve the WSDL and imported XSD digests used for the test.

## Routing and schema

- Compare HTTP path, content type, SOAPAction or action parameter, body QName, WS-Addressing action, and backend dispatch.
- Test omitted, duplicate, reordered, namespace-shifted, nil, defaulted, polymorphic, and unknown elements against deployed schema validation.
- Include gateway transformations and alternate SOAP 1.1/1.2 listeners; do not assume their parsers agree.

## WS-Security

- Trace token validation, timestamp and replay cache, audience, recipient, actor/role, signature reference resolution, canonicalization, transform allowlists, and encrypted element coverage.
- Verify that every security-relevant body and header element is signed as intended and that duplicate IDs or wrapping cannot redirect application reads.
- Separate cryptographic validity from identity mapping, tenant selection, operation authorization, and object authorization.

## Parser and attachments

- Keep DTD, entity, XInclude, decompression, recursive schema, and attachment tests local or tightly bounded; never induce uncontrolled expansion.
- Review MTOM/XOP and MIME part count, size, content type, reference binding, storage, and cleanup.
- Compare fault and success paths for parser differences, sensitive detail, retry ambiguity, and partially committed effects.

## Evidence

Record endpoint, SOAP version, action values, body QName, schema digest, security header summary, actor, tenant, request digest, response/fault digest, timing, and durable effect. Redact credentials and retain only their environment name and digest.
