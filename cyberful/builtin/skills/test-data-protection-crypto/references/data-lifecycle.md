# Sensitive-Data Lifecycle

## Exposure Surfaces

Inspect:

- request and response bodies, URLs, headers, cookies, and redirects;
- application, proxy, audit, crash, debug, tracing, and query logs;
- client storage, caches, offline queues, clipboard, notifications, and screenshots;
- databases, indexes, search clusters, object stores, replicas, snapshots, and backups;
- exports, reports, CSV formulas, support bundles, and admin tools;
- test fixtures, seed data, source maps, build artifacts, package registries, and CI logs;
- error messages, metrics labels, traces, and dead-letter queues.

Trace derived data too: hashes of small domains, stable pseudonyms, embeddings, thumbnails, OCR text, and redacted values may remain identifying or reversible.

## Secret Discovery Triage

For each candidate, determine whether it is:

- syntactically secret-like but inert;
- test or example material;
- expired or revoked;
- live but low privilege;
- live and privilege-bearing;
- a root, signing, recovery, or deployment credential.

Establish scope and rotation path without unnecessarily exercising the credential. Search commit history, generated artifacts, CI configuration, container layers, mobile packages, and runtime environment construction.

## Retention and Deletion Proof

Follow deletion through primary records, indexes, materialized views, caches, object versions, event logs, replicas, backups, downstream processors, and derived artifacts. Record whether deletion is immediate, scheduled, cryptographic, or only hidden from the UI.

## High-Yield Hints

- Redaction after serialization may miss nested, binary, exception, or structured-log fields.
- Authorization-aware responses can still leak through shared traces, exports, search indexes, or support impersonation.
- URL query secrets propagate into referrers, browser history, proxy logs, and link scanners.
- Tokenization can be reversible through an overprivileged detokenization service.
- A tenant-scoped encryption claim fails when key selection, associated data, cache, or backup restore is not tenant-bound.
- Restored snapshots can resurrect revoked sessions, old keys, or deleted records unless freshness state lives outside the snapshot.
