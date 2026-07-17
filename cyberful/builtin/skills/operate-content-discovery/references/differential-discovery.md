# Differential Discovery Heuristics

## Response vectors

Model each response as:

status | bytes | words | lines | title | location | content-type | server/cache markers | stable body hash | latency

No single dimension is authoritative. Build a baseline cluster from multiple random controls, then search for distance from that cluster.

Useful hidden signals:

- identical body with different redirect target;
- same length but different word/line distribution;
- stable header change such as Allow, WWW-Authenticate, ETag, Vary, cache status, or backend ID;
- 404 at edge versus 200/403 from origin;
- gzip/content-encoding causing byte length instability while decoded structure stays stable;
- reflected path token making every random response a unique size;
- localized or randomized error templates;
- request ID/timestamp/nonces that defeat raw hashes.

Normalize known volatile fields before comparing bodies.

## Filtering traps

- Filtering 404 discards real routes that deliberately return 404 for unauthorized users.
- Filtering 403 discards protected handlers and vhost routing evidence.
- One size filter fails when reflection or localization changes response size.
- Auto-calibration can calibrate against a temporarily challenged/WAF-blocked state.
- Following redirects during discovery can collapse many distinct handlers into one login page.
- Matching only 200/204 loses redirects, method hints, and authentication boundaries.
- High concurrency can make rate-limit pages become the dominant baseline.

Maintain a low-rate control request during long campaigns. When its vector changes, segment the run; filters learned before the transition are no longer valid.

## Virtual-host discovery

Connect to a known IP/hostname while fuzzing Host. Account for:

- TLS SNI: HTTPS may terminate before Host routing, so candidate certificates or a controlled SNI path may be required.
- CDN origin protection: direct IP can return a provider default unrelated to the target.
- DNS wildcard: resolve random labels and compare IP sets/TTL/CNAME chains.
- canonical redirects: a vhost may reveal itself only through a distinct Location.
- absolute URL generation: Host reflection can create false differences; compare body structure and backend markers.

Validate a candidate by resolving/routing it consistently and comparing at least two nonexistent sibling hosts.

## Parameter discovery

Detect parameters by behavior, not mere reflection:

- status/redirect transition;
- validation error or schema branch;
- cache-key change;
- backend timing change;
- authorization decision;
- response field inclusion/exclusion;
- content-type negotiation;
- method behavior;
- error provenance.

Send absent, empty, scalar, repeated, array/object, null-like, malformed, and duplicate representations. Framework binders may recognize a parameter only in one encoding or precedence position.

## Recursion economics

Recursive fuzzing multiplies requests and noise. Recurse only branches with evidence:

- directory semantics (slash redirect, index, listing);
- asset/module naming;
- route group response;
- framework prefix;
- source/schema reference;
- authentication boundary;
- distinct error provenance.

Use depth-specific baselines. A framework's /a/b/random error often differs from its root-level random path.

## High-yield wordlist synthesis

Extract tokens from:

- JavaScript chunks, source maps, manifests, router tables;
- OpenAPI/AsyncAPI/GraphQL schemas and client SDKs;
- error messages, localization keys, telemetry names;
- mobile binaries/resources and deep-link declarations;
- deployment manifests, ingress rules, reverse-proxy config;
- public docs, changelogs, status pages;
- discovered filenames and sibling naming morphology.

Generate variants deliberately: singular/plural, kebab/snake/camel, API versions, CRUD/action suffixes, environment suffixes, archive/editor suffixes, and common framework management routes.

## Evidence grading

- **Strong:** stable differential across controls plus manual replay proving a distinct handler/resource.
- **Moderate:** repeatable vector outside baseline but handler identity remains unclear.
- **Weak:** one-off size/timing/status anomaly under unstable edge conditions.

Retain weak anomalies as pivots; do not inflate them into route inventory.
