# Threat Elicitation Catalog

## Identity and authority

- identity proofing weaker than the authority granted;
- registration, invitation, recovery, linking, federation, support, or migration paths that bypass the primary ceremony;
- confused issuer, audience, client, tenant, subject, assurance level, or delegated actor;
- stale role, group, relationship, entitlement, session, or policy cache;
- authority accepted from a client, gateway, queue message, model, or integration without local binding;
- missing deny-by-default path, revocation, separation of duties, or step-up authentication.

## Data and parser boundaries

- alternate encodings, canonical forms, duplicate parameters, ambiguous types, content-type disagreements, and parser differentials;
- data crossing SQL, NoSQL, LDAP, XPath, template, shell, expression, logging, spreadsheet, browser, or serialization interpreters;
- archive, path, symlink, upload, document, image, XML, and decompression boundaries;
- over-broad response, log, cache, export, backup, analytics, or client-side persistence.

## Workflow and distributed state

- skipped, replayed, reordered, duplicated, concurrent, expired, or partially committed transitions;
- inconsistent authority across services, replicas, caches, queues, webhooks, and compensating actions;
- negative values, overflow, precision, currency, unit, quantity, discount, quota, refund, and settlement errors;
- idempotency scoped to the wrong actor, tenant, operation, or payload;
- support and administrative paths that bypass ordinary invariants.

## Infrastructure and supply chain

- unintended registry or dependency resolution, install/build execution, untrusted contribution context, or mutable artifact;
- CI token, runner, cache, artifact, signing, promotion, or reusable workflow authority crossing trust levels;
- cloud workload identity, metadata, object storage, control plane, secret mount, service account, or network policy exposure;
- debug, admin, metrics, health, source map, backup, development, search, or management service reachable outside its trust zone.

## Browser and protocol composition

- cross-origin read/write, framing, navigation, messaging, storage, opener, service worker, or script trust;
- CDN, proxy, gateway, cache, WAF, server, and framework disagreement over message boundaries, hosts, paths, methods, or cache keys;
- long-lived socket identity, channel authorization, revocation, backpressure, and fan-out;
- webhook authenticity, freshness, replay, ordering, idempotency, and downstream state validation.

## Agentic AI

- untrusted text influencing instructions, memory, retrieval, tool choice, arguments, output consumers, or future users;
- tool authority broader than user authority or stated intent;
- sensitive context exposed through model output, embeddings, logs, traces, or shared memory;
- poisoned documents, indexes, models, adapters, plugins, or evaluation data;
- unvalidated model output entering code, queries, templates, workflows, or decisions;
- recursive or adversarial inputs causing unbounded token, tool, retrieval, or financial consumption.

## Availability and recovery

- work amplification, algorithmic complexity, catastrophic regular expressions, decompression, fan-out, queue growth, lock contention, memory retention, and paid downstream actions;
- health checks that ignore a failed security dependency;
- fail-open authorization, verification, logging, rate limiting, secret, or policy services;
- missing forensic linkage, tamper-evident audit, cleanup, rollback, rotation, or containment path.
