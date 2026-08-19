# Workload identity method

Use this reference for service accounts, OAuth clients, workload federation, token exchange, runtime attestations, and delegated service calls.

## Identity tuple

Record:

`issuer | workload subject | client | actor | delegated subject | tenant | audience | scopes | token type | credential state | runtime attestation | relying service | policy owner`

Do not collapse client, service account, runtime instance, and delegated user into one principal.

## Lifecycle review

- Issuance requires an authenticated workload or approved bootstrap and binds the intended issuer, subject, audience, tenant, and credential type.
- Federation maps cloud, cluster, repository, build, or hardware attributes through exact conditions rather than broad wildcards.
- Exchange narrows audience and authority, preserves the actor chain, and rejects inappropriate token types or replay contexts.
- Delivery avoids logs, command arguments, images, metadata exposed to unrelated workloads, and shared writable volumes.
- Authorization evaluates the machine principal and delegated subject required by the operation instead of silently replacing one with the other.
- Rotation and revocation have bounded propagation and invalidate caches, sessions, exchanged tokens, and derived credentials according to policy.

## Controlled comparisons

Use one accepted control and one expected denial for each binding dimension. Prefer synthetic resources and non-destructive reads. Token rejection, an error difference, or credential discovery without server-side acceptance is not sufficient impact; identify the authority obtained and the protected effect.

## Runtime route boundary

Treat the mission-bound Cyberful gateway or ZAP route as the transport authority. The campaign file may constrain exact origins and request limits but must never supply proxy or CA paths. Non-loopback probes inherit the matching `HTTP_PROXY` or `HTTPS_PROXY` plus `SSL_CERT_FILE` or `CURL_CA_BUNDLE` from cyberful-os after the model boundary; loopback IP literals bypass proxy inheritance explicitly.
