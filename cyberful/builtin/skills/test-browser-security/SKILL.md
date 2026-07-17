---
name: test-browser-security
description: Assess browser-side trust boundaries, script and DOM injection, origin policy, cross-site actions, navigation, messaging, storage, service workers, and side channels during authorized penetration tests or code audits. Use for XSS, DOM XSS, CSP, Trusted Types, CORS, CSRF, clickjacking, postMessage, opener, prototype pollution, XS-Leaks, and client-side authorization questions.
---

# Test Browser Security

## Establish the Browser Trust Model

Map origins, subdomains, embedded contexts, trusted script sources, browser storage, service workers, privileged UI, and server endpoints reached by the client. Record the attacker position: unauthenticated web origin, attacker-controlled tenant content, compromised third-party script, malicious extension, or adjacent trusted origin.

Treat browser controls as compositional. CSP does not repair unsafe DOM construction, SameSite does not replace CSRF validation, CORS does not authorize requests, and UI gating does not enforce server authorization.

Read [dom-and-script.md](references/dom-and-script.md) for script-capable dataflows. Read [origin-navigation-storage.md](references/origin-navigation-storage.md) for origin, navigation, messaging, storage, and side-channel review.

## Trace Client-Side Dataflows

1. Inventory sources: URL components, referrer, window name, messages, storage, API data, DOM attributes, uploaded content, and third-party SDK output.
2. Trace transformations through decoders, template engines, sanitizers, virtual DOM escape hatches, and raw HTML APIs.
3. Classify sinks by capability: HTML parsing, script execution, URL navigation, CSS interpretation, code generation, or privileged browser API.
4. Determine whether the relevant control dominates every path and operates in the final parser context.
5. Use inert markers and observable DOM or network effects before escalating to an execution proof.

Do not equate reflection with XSS. Establish that untrusted data reaches a browser interpretation boundary with an executable or security-relevant effect.

## Test Cross-Origin and Cross-Site Boundaries

Build a matrix of origin, site, credentials mode, method, content type, preflight behavior, response readability, and state change. Separate:

- ability to send from ability to read;
- origin policy from application authorization;
- simple from preflighted requests;
- same-site from same-origin assumptions;
- navigation, subresource, form, fetch, and framed contexts.

For CSRF, prove a state-changing operation is reachable with ambient credentials and lacks a request-bound defense. For CORS, prove an attacker origin can read protected data or exercise a privileged response, not merely that permissive headers exist.

## Review Browser Policy as Defense in Depth

Evaluate CSP nonce and hash lifecycle, strict-dynamic behavior, unsafe fallbacks, report-only drift, frame restrictions, Trusted Types enforcement, Referrer-Policy, Permissions-Policy, isolation headers, and MIME sniffing controls. Determine the effective policy after duplicate headers, redirects, CDN behavior, meta tags, and browser compatibility.

Include gadgets in allowed scripts, JSONP endpoints, same-origin uploads, unsafe base URIs, and DOM clobbering in the policy graph.

## Produce Decisive Evidence

Capture the smallest reproducible input, resulting DOM or request, execution context, authenticated state, effective browser policy, and impact. Distinguish confirmed exploitability, defense weakness, and hardening. Recommend correcting the unsafe dataflow or authorization boundary first, then tightening browser policy.
