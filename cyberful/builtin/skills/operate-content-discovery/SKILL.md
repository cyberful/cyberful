---
name: operate-content-discovery
description: Design and interpret advanced content discovery with ffuf and complementary web fuzzers. Use for path, file, extension, parameter, value, header, method, API object, virtual-host, subdomain, backup, and recursive discovery when response normalization, wildcard routing, authentication, rate limits, or edge behavior make naive status-code filtering unreliable.
---

# Operate Content Discovery

Treat discovery as response classification under controlled mutations. The goal is a compact set of meaningful differentials, not a large set of URLs.

## Calibrate before fuzzing

1. Capture several random nonexistent requests with equal path depth and extension shape.
2. Compare status, body length/words/lines, title, redirect target, content type, cache headers, timing, and stable body fingerprints.
3. Repeat with and without authentication, cookies, expected headers, trailing slash, alternate method, and cache buster.
4. Identify wildcard DNS, catch-all virtual hosts, framework soft-404s, CDN/WAF challenges, and login redirects.
5. Select filters from a distribution, never from one response.

Read [references/differential-discovery.md](references/differential-discovery.md) before choosing -fs, -fw, -fl, -fc, or auto-calibration.

## Choose the mutation axis

- Paths/directories: target/FUZZ
- Files/extensions: FUZZ plus a justified extension set
- Parameters: known route with parameter-name wordlist
- Values/identifiers: one parameter at a time with semantic value classes
- Virtual hosts: Host: FUZZ.example while connecting to the resolved service
- Headers: only headers the stack is likely to route or trust
- Methods: explicit small method set against a known route
- API objects/actions: nouns, pluralizations, versions, verbs, and framework conventions

Do not mix axes until each axis has a stable baseline; otherwise response clusters become uninterpretable.

## Run ffuf as an experiment

Use the dedicated ffuf tool with an argv array. Set:

- one wordlist and one FUZZ position per pass;
- explicit concurrency and delay/rate appropriate to the target;
- request timeout that exceeds observed high-percentile latency;
- replay proxy only when every match needs capture;
- JSON/eJSON output under the workarea;
- matchers broad enough to preserve anomalies, then filters for known baselines.

Prefer the bundled frequency-ordered cyberful-os lists for capped campaigns. Promote discovered directories, technologies, schema names, and route fragments into a smaller second-stage wordlist.

## Validate each cluster

For every candidate cluster:

1. replay one hit and two nearby controls;
2. vary only the discovered token;
3. compare unauthenticated and relevant authenticated roles;
4. test slash, case, encoding, extension, and method only when routing evidence supports them;
5. inspect full headers/body and follow redirects manually;
6. classify as real resource, routed alias, authorization boundary, input reflection, wildcard artifact, transient edge state, or unknown.

An authorization response is discovery: a stable 401/403 differential can reveal a real handler even without content. A 200 can still be a soft-404.

## Pivot intelligently

- Directory listing or index leak -> extract names and recurse only those branches.
- JavaScript/source map/OpenAPI/GraphQL schema -> build application-specific route and parameter lists.
- Framework/admin signature -> add framework conventions, versioned assets, health/metrics/debug routes.
- Backup/temp artifact -> pivot to sibling naming, deployment timestamps, editor suffixes, archive formats.
- Distinct vhost -> recalibrate from scratch for that host; do not reuse filters.
- Stable timing outlier -> replay serially and separate backend work from queue/CDN jitter.

## Report

Preserve baseline samples, wordlist identity/hash, command arguments, filters/matchers, rate/concurrency, authentication context, raw output, validated candidates, rejected clusters, and coverage gaps. Report discovered attack surface separately from confirmed vulnerabilities.
