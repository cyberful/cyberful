# SAML Federation

## Trust model

Inventory identity providers, service providers, entity IDs, endpoints, bindings, metadata sources, signing and encryption keys, certificate rollover, requested authentication context, NameID formats, attribute mapping, tenant mapping, and provisioning authority.

## Response validation

Validate schema before use; signature on the intended response or assertion; trusted algorithm and key; issuer; audience restriction; destination; recipient; `InResponseTo`; subject confirmation; validity windows; one-time/replay state; session index; and the exact assertion whose attributes are consumed.

Prevent signature wrapping by using hardened libraries and selecting validated nodes rather than re-querying the document by ambiguous identifiers after verification.

## Binding and transport

Assess HTTP Redirect, POST, Artifact, and SOAP binding semantics separately. Verify relay state integrity and purpose, artifact redemption authentication, endpoint allowlists, message size, decompression, XML parser settings, and transport confidentiality.

## Identity mapping

Use issuer-qualified immutable subjects. Do not treat email or display name as globally stable identity unless the trust contract explicitly guarantees it. Verify group and role mapping, default roles, tenant routing, JIT provisioning, deprovisioning, account linking, and identifier recycling.

## Single logout and lifecycle

Validate logout request/response signatures and destinations, session index binding, local session termination, partial logout behavior, replay, and operational expectations when one federation party is unavailable.
