---
name: test-soap-xml-services
description: Test authorized SOAP and XML services for WSDL drift, WS-Security, action routing, identity, authorization, signature, encryption, parser, and schema-boundary failures. Use for SOAP 1.1/1.2, WSDL, XSD, XML gateways, and legacy service assessments.
metadata:
  domain: application-security
  subdomain: soap-xml-security
  triggers:
    - test SOAP security
    - WSDL security assessment
    - WS-Security review
    - XML service authorization
    - SOAPAction routing test
  tags:
    - SOAP
    - XML
    - WSDL
    - XSD
    - WS-Security
    - parser
  frameworks:
    mitre_attack:
      - T1190
    nist_csf:
      - PR.AA
---

# Test SOAP and XML Services

Treat HTTP routing, SOAP version, action selection, XML parsing, schema validation, WS-Security processing, and application authorization as distinct boundaries. A valid signature does not authorize the signed operation, and a WSDL declaration does not prove deployed enforcement.

Read [soap-xml-testing.md](references/soap-xml-testing.md) before testing signatures, encryption, namespaces, schema ambiguity, attachments, or SOAPAction differentials.

For bounded HTTP probes in Pentest or Bug Bounty, stage [scripts/run_soap_xml_probe.py](scripts/run_soap_xml_probe.py), its [manifest](scripts/manifest.json), and the [example](assets/soap-xml-probe.example.json). The helper invokes fixed `curl`, accepts campaign constraints rather than authority, resolves secrets only from `CYBERFUL_SOAP_AUTHORIZATION` after preflight, and cannot select proxy, CA, or TLS verification through JSON. Literal loopback connects directly; non-loopback endpoints require Cyberful's runtime proxy and CA bundle. The request envelope is streamed only through bounded stdin and never placed in argv. It is unavailable for Code Audit target traffic.

## Test matched requests

Start from one valid minimal envelope and vary one decision at a time: action header versus body QName, namespace, mustUnderstand, actor/role, timestamp, token reference, signed elements, duplicate IDs, schema type, optional/default fields, attachment reference, and gateway content type. Keep entity expansion and resource probes synthetic and bounded.

Report only demonstrated security consequences. Preserve WSDL/XSD digest, endpoint, SOAP version, action, actor, tenant, redacted envelope digest, HTTP/SOAP fault, response digest, and downstream effect.
