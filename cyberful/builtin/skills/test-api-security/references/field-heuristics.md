# API Field Heuristics

## Find Behavior the Contract Hides

- Diff route tables, gateway configuration, generated SDKs, mobile bundles, source annotations, and runtime traffic. Each view omits a different class of operation.
- Probe alternate media types and HTTP methods against the same logical operation; authentication or validation middleware is often registered per parser or verb.
- Compare JSON, form, multipart, XML, protobuf transcoding, and batch wrappers for null, duplicate, unknown, default, and numeric-field semantics.
- Inspect error schemas, OPTIONS, method-not-allowed responses, link relations, pagination cursors, job status endpoints, and generated client symbols to recover undocumented capabilities.
- Follow deprecated fields and versions into current data models. A hidden legacy writer can mutate fields exposed only by a modern reader.

## Cross-Layer Differentials

- Gateway and application may disagree on path decoding, method override, content length, tenant headers, JWT claims, or response caching.
- Validation may operate on a DTO while mass assignment later binds the original body or nested object.
- A service can validate a user-facing resource ID, then consume an alternate ID from a nested relationship, header, or queued message.
- API caches and DataLoaders must key on tenant, principal-sensitive visibility, representation, and policy version-not only object ID.
- An API may authorize job creation but expose status, result, cancellation, retry, or download by a weaker identifier.

## State and Collection Hints

- Test cursor reuse across principal, tenant, filter, sort, page size, and dataset mutation. Opaque does not imply bound.
- Search, count, autocomplete, aggregate, and "exists" endpoints can disclose authorization state without returning objects.
- Bulk endpoints may authorize the collection or first item and then process all elements.
- Partial failure can commit authorized and unauthorized elements differently or leak which objects exist.
- ETags, conditional requests, range responses, and pre-signed downloads may outlive revocation.
- Dry-run, validation, quote, preview, export, and import endpoints often execute expensive or privileged logic before the final guarded action.

## Machine and Async Chains

- A user can enqueue an action under current authority that executes after revocation with a stronger worker identity.
- Identity metadata copied into messages can be forged, stale, or audience-inappropriate even when the producer endpoint authenticated correctly.
- Retry and dead-letter tools often expose a privileged replay path with weaker object and tenant checks.
- Service tokens accepted by broad audience create lateral movement when downstream services trust client-supplied actor headers.
- Webhook configuration can combine URL fetch, secret delivery, event disclosure, and persistent cross-tenant routing.

## False-Negative Traps

- Testing only the published base URL, newest version, default region, or browser client.
- Treating a 404 as authorization without comparing timing, cache, body, headers, and downstream state.
- Fuzzing values while ignoring attacker-controlled keys, field presence, order, and type.
- Assuming the OpenAPI security declaration is enforced at runtime.
- Checking synchronous responses without waiting for queues, notifications, exports, and reconciliation.
