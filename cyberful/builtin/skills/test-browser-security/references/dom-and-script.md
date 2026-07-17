# DOM and Script Review

## Capability-Oriented Sink Catalog

Trace each sink to the parser or API that gives it meaning:

- HTML: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, document writing, raw template directives, unsafe hydration, and SVG or MathML insertion.
- Script: dynamic script elements, event attributes, javascript URLs, string timers, `eval`, `Function`, WebAssembly loaders, and dynamic module specifiers.
- Navigation: `location`, `open`, form actions, router redirects, meta refresh, and URL-valued attributes.
- CSS: style text, selectors, URL-bearing properties, and browser-specific execution surfaces.
- Framework escape hatches: raw HTML APIs, sanitizer bypass types, unsafe refs, direct DOM mutation, and client-side template compilation.

Account for nested interpretation. Data can be safe for JSON but unsafe after HTML insertion, safe for HTML text but unsafe in an attribute, or safe for a URL parser but unsafe when reparsed by a downstream protocol handler.

## Sanitization Proof

For every sanitizer, record:

1. exact library and version;
2. configuration, hooks, allowed elements, attributes, protocols, and custom elements;
3. whether data is decoded or mutated after sanitization;
4. whether the sanitized value has a type preventing unsafe reuse;
5. all alternative render paths;
6. browser mutation or namespace behavior relevant to the content.

Encoding must be contextual and occur at the final interpretation boundary. Regex filtering is not a general HTML sanitizer.

## DOM Clobbering and Prototype Pollution

Review whether named elements can replace expected DOM properties, configuration objects inherit attacker-controlled properties, recursive merge functions accept `__proto__`, `prototype`, or `constructor`, and polluted properties reach script, URL, fetch, or security decisions.

Prove the complete chain: pollution or clobbering primitive, reachable gadget, execution context, and effect. A pollution primitive without a relevant gadget is not equivalent to code execution.

## High-Yield Audit Heuristics

- Search for sanitizer results later concatenated, decoded, templated, or assigned into a different sink class.
- Compare server-rendered and hydrated DOM; hydration repairs can activate text that was inert in the original response.
- Inspect error, empty-state, localization, preview, admin, and export views; they often bypass the primary rendering abstraction.
- Treat source maps, tag managers, runtime config, and feature-flag payloads as maps of otherwise hidden client paths.
- Follow attacker-controlled object keys into configuration merges; values are not the only tainted dimension.
