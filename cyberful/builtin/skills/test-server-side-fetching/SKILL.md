---
name: test-server-side-fetching
description: Assess server-side URL retrieval and network egress during authorized penetration tests or code audits. Use for SSRF, blind SSRF, URL parser confusion, DNS rebinding, redirect validation, webhook callbacks, importers, previews, PDF or image fetchers, cloud metadata access, alternate protocols, internal service reachability, and egress-policy review.
---

# Test Server-Side Fetching

## Inventory Fetch Capabilities

Find every feature that causes a trusted component to resolve or connect to an influenced destination: URL previews, webhooks, imports, feed readers, image proxies, document renderers, SSO metadata, repository integrations, health checks, headless browsers, and indirect downstream fetchers.

For each fetcher, record input source, parser, normalization, DNS resolver, proxy, redirect policy, supported schemes, credential attachment, network namespace, response handling, retry behavior, and caller-visible output.

Read [url-dns-redirects.md](references/url-dns-redirects.md) for validation differentials. Read [egress-cloud.md](references/egress-cloud.md) for network and cloud containment.

## Trace the Resolution Lifecycle

Test controls at every stage:

1. parse and canonicalize the submitted URL;
2. validate scheme, authority, host, and port;
3. resolve all address records;
4. classify every resolved address;
5. connect to the validated address without unchecked re-resolution;
6. validate every redirect target from scratch;
7. constrain response size, time, type, and recursive fetches.

An allowlist checked only before redirects or against a string representation is incomplete.

## Confirm the Primitive

Use engagement-controlled endpoints and unique correlation tokens. Begin with outbound DNS or HTTP and record source address, method, headers, timing, redirect behavior, and retry cadence. For blind paths, correlate asynchronous callbacks and separate resolver traffic from application fetch traffic.

Timing is supporting evidence only when matched controls exclude application variance. A benign internal status or controlled listener can establish reach without collecting sensitive internal data.

## Audit Response and Credential Handling

Determine whether the fetcher:

- returns bodies, headers, screenshots, parsed metadata, or timing;
- forwards cookies, service credentials, proxy credentials, client certificates, or authorization headers;
- renders active content or parses fetched files;
- follows nested references;
- stores content where another security boundary consumes it.

Chain into file-parser or browser analysis when the fetched object enters those interpreters.

## Classify Reach Precisely

State whether the issue provides DNS interaction, arbitrary outbound connection, internal HTTP write, internal read, authenticated service access, response exfiltration, non-HTTP protocol access, or code-adjacent parser reach. Include network context, redirect and DNS behavior, and the narrowest architectural correction.
