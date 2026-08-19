---
name: test-browser-security
description: Route broad browser-security assessments to focused Cyberful skills for DOM and script dataflows, origin policy, navigation, messaging, storage, caching, and request normalization. Use when an authorized browser review spans several client-side trust boundaries or the correct specialist is not yet clear.
metadata:
  domain: application-security
  subdomain: browser-security-routing
  triggers:
    - broad browser security assessment
    - client-side security review
    - browser trust boundary audit
    - DOM and origin security
    - cross-site control review
  tags:
    - browser-security
    - DOM
    - origin-policy
    - CSP
    - CORS
    - CSRF
  frameworks:
    nist_csf:
      - ID.RA
---

# Test Browser Security

Use this skill to map origins, embedded contexts, trusted scripts, storage, service workers, privileged UI, and server endpoints, then route each hypothesis to one focused owner.

## Route by browser boundary

- Use `test-browser-messaging-boundaries` for `postMessage`, opener, frame, worker, extension, and cross-context capability transfer.
- Use `trace-request-normalization` when browser, CDN, proxy, framework, or cache parses the same request differently.
- Use `test-web-cache-behavior` for cache keys, variants, poisoning, deception, authenticated caching, or revalidation.
- Use `test-authorization-boundaries` when the decisive control is server-side authority rather than UI visibility.
- Use `test-file-parser-security` or `trace-file-processing-pipelines` when uploads, downloads, documents, media, or active content cross a parser boundary.

For DOM XSS, CSP, Trusted Types, CORS, CSRF, clickjacking, prototype pollution, navigation, storage, service workers, and XS-Leaks that do not fit a narrower specialist, retain this router as coordinator. Read [dom-and-script.md](references/dom-and-script.md) only for script-capable dataflows. Read [origin-navigation-storage.md](references/origin-navigation-storage.md) only for origin, navigation, storage, and side-channel reconciliation.

## Coordinate decisive evidence

Treat browser controls as compositional: CSP does not repair unsafe DOM construction, SameSite does not replace CSRF validation, CORS does not authorize requests, and UI gating does not enforce server authorization. Assign each hypothesis once, preserve origin/site/credentials and browser-policy context, and consolidate the smallest reproducible effect. Distinguish a confirmed boundary failure from a defense weakness or hardening opportunity.
