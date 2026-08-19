# Browser MCP

The browser MCP drives five isolated target profiles plus one named `search` profile in headed Chromium and exposes structured DOM, page, network, cookie, artifact, and public-web search operations. It does not provide screenshot or vision tools and does not solve CAPTCHAs. Every `browser_*` tool accepts an optional `profile` of `1` through `5` or `"search"`; omitting it selects profile 1. `web_search` has no profile argument and is always routed to `search`.

The builtin `operate-browser` skill is the agent-facing operational contract for this runtime. Live-target personas load it before their first browser call so profile routing, stored-variable login, identity isolation, snapshot pagination, CAPTCHA handoff, interrupted-mutation handling, evidence preservation, and passive dependency classification have one reusable source. The active phase persona still owns when browser work is required and what constitutes readiness or completion; the skill never expands mission authority.

Browser discovery and dispatch share one registry: duplicate names or a tool without an object schema and handler stop startup before Chromium is launched. The phase gateway owns one lazy Chromium hub for each profile `1`–`5` and `search`. Every root, subagent, and fallback `AgentRun` gets a lazy CDP controller keyed by `(runID, profile)` and can observe only the tabs created by that controller.

## DuckDuckGo web research

`web_search` opens DuckDuckGo's [official non-JavaScript HTML surface](https://duckduckgo.com/duckduckgo-help-pages/features/non-javascript) in Chromium rather than calling a private search API or depending on the dynamic JavaScript UI. It accepts a 1–500 character `query`, `max_results` from 1 through 20 (default 10), `safe_search` as `strict`, `moderate`, or `off` (default `moderate`), and a bounded `timeout_ms` (default 30 seconds); safe-search is encoded through DuckDuckGo's [documented URL parameters](https://duckduckgo.com/duckduckgo-help-pages/settings/params). One call reads one result page and never retries automatically.

The JSON result identifies the engine, `search` profile, original query, count, truncation state, and ranked results. Organic and sponsored results remain labelled separately; DuckDuckGo redirect links are resolved to final HTTP(S) destinations. A genuine empty result page returns an empty list, while an unknown layout fails explicitly instead of pretending there are no sources.

The `search` profile is credential-free relative to target identities and persists at `~/.cyberful/browser/profiles/search`, with artifacts at `~/.cyberful/browser/artifacts/search`. It uses the direct route `browser/direct-search`: gateway startup removes inherited ZAP proxy configuration, ZAP trust, shared CDP ownership, and CDP attestation only for this profile. The numbered profiles keep their normal ZAP route and trust. All HTTP(S) destinations are technically reachable from `search`; the mission and persona remain the authority for allowed traffic.

A DuckDuckGo challenge is an actionable tool error, not a retry signal. Use `browser_captcha_status` and `browser_captcha_handoff` with `profile: "search"`, then retry only after the human resolves the foregrounded challenge. The CAPTCHA circuit remains isolated by AgentRun, profile, origin, and tab.

## Bounded DOM snapshots

`browser_snapshot` defaults to 12,000 visible-text characters and 80 actionable elements. Keep those defaults for the first read. On long pages, pass a CSS `selector` to confine both text and actionable refs to the first matching subtree, then use the returned `next_text_offset` as `text_offset` for later non-overlapping slices. Increase `max_text_chars` or `max_elements` only when scoping and pagination are insufficient; the hard limits remain 100,000 characters and 500 elements.

Every result reports the selected scope, selector match count, text interval `start-end/total`, next offset when more text exists, returned and total interactive-element counts, and separate text/element truncation flags. Refs are generated only for interactive descendants of the selected scope. An invalid selector or a selector with no matches returns an explicit tool error. When several nodes match, text and refs come from the first and the result retains the total match count so the caller can refine the selector.

Each profile owns separate cookies, local storage, cache, downloads, artifacts, and a Chromium profile lock. Inside one profile, AgentRun controllers share those authentication and storage surfaces but own disjoint tabs, DOM state, snapshot refs, active-page state, network logs, and response-body IDs. This makes role-to-role and tenant-to-tenant comparisons possible across numbered profiles without moving session tokens between accounts. A mission can say, for example, "profile 1 contains the buyer and profile 2 the seller"; Cyberful maps those identities to `profile: 1` and `profile: 2` on every browser call.

## AgentRun tab ownership

`browser_tabs` accepts `list`, `open`, `select`, and `close`; `tab_id` is mandatory for `select` and `close`. `list` and `browser_status` expose only tabs owned by the caller. `open` creates a blank active tab, popups and `window.open` inherit their opener's owner, and the next page-scoped action recreates a private tab after the last one closes. A foreign or stale ID is reported as nonexistent. `_meta["cyberful.dev/browser-action"].page_id` is the stable opaque ID of the active owned tab.

Calls serialize only within one `(runID, profile)` controller, so sibling AgentRuns can operate concurrently on the same hub. At AgentRun completion, cancellation, provider failure, or recovery replacement, the runtime sends a host-owned cleanup notification and closes all tabs of that run. It does not close the hub or sibling controllers. `browser_close` is absent from subagent and fallback catalogs and the gateway rejects missing, malformed, child, and stale actors even on a direct call. Only the original phase root can close all controllers and the selected hub; a later call recreates the profile lazily. A nested subagent that has children does not acquire root authority.

## Pre-authenticate profiles manually

From a global npm installation, open the identity you want to seed:

```sh
cyberful browser-1
cyberful browser-2
# ...through cyberful browser-5
```

The command installs the isolated Chromium build when necessary, opens the same persistent profile used during tests, and remains attached until the browser is closed or the command is interrupted. Invalid or unavailable profile numbers fail with a non-zero status. Source contributors can use the equivalent `make browser-run-1` through `make browser-run-5` targets.

Sign in only to the authorized target account for that identity, then fully close the Chromium window. The command returns after the browser exits and releases its profile lock. Repeat for other accounts, then run Cyberful and tell it which account is stored in each numbered profile. Do not leave a manual profile open when starting Cyberful: a locked profile is replaced with a temporary unauthenticated fallback for that run rather than risking corruption.

The default persistent locations are `~/.cyberful/browser/profiles/cyberful` for profile 1, `~/.cyberful/browser/profiles/cyberful-2` through `cyberful-5` for the remaining target identities, and `~/.cyberful/browser/profiles/search` for public web research. Never point any profile at a personal daily-use browser directory.

The installed binary downloads open-source Chromium on first use and stores it in the Cyberful cache. To use real Google Chrome for all browser identities, or override one explicitly prepared profile, set values in the launch directory's `.env`:

```dotenv
CYBER_BROWSER_CHANNEL=chrome
CYBER_BROWSER_USER_DATA_DIR_2=/absolute/path/to/dedicated-profile-2
```

`CYBER_BROWSER_USER_DATA_DIR` remains the compatibility override for profile 1; `CYBER_BROWSER_USER_DATA_DIR_1` through `_5` are the numbered overrides and take precedence. `CYBER_BROWSER_USER_DATA_DIR_SEARCH` overrides the named research profile. Matching `CYBER_BROWSER_ARTIFACTS_DIR_1` through `_5` and `CYBER_BROWSER_ARTIFACTS_DIR_SEARCH` values override download directories. Fully close every seeded browser before Cyberful starts so its profile lock is released. Chromium is the distribution-safe default; `CYBER_BROWSER_CHANNEL=auto` prefers Chrome when it is installed.

Key controls include `CYBER_BROWSER_HEADLESS`, `CYBER_BROWSER_CLEAR_COOKIES_ON_START`, `CYBER_BROWSER_ARTIFACTS_DIR`, `CYBER_BROWSER_STEALTH`, and `CYBERFUL_SKIP_BROWSER_PREFLIGHT`. When ZAP proxying is enabled, the host injects the loopback proxy and trust pin; users should not manually supply its API keys.

A visible CAPTCHA is handed to the human through the TUI while the challenged page is preserved and foregrounded. The version 2 breaker stores multiple entries and limits each one to its AgentRun, profile, tab, and origin; other AgentRuns, profiles, origins, tabs, and non-browser tools keep working. The reader accepts the former single-entry state as a legacy wildcard owner. Provider SDK traffic, response fields, and a lone generic CAPTCHA mention remain diagnostic signals but do not, by themselves, count as a visible challenge or open a handoff. After checking the foregrounded browser, the human can choose:

- `Resolved` after completing a visible challenge; Cyberful then verifies the original page with `browser_captcha_status`;
- `No challenge visible` to clear a false-positive pause explicitly;
- `Cannot resolve` to keep that profile and origin paused.

Cyberful never solves the challenge, injects a bypass token, or interprets ordinary session steering as one of these decisions.

Browser gateway startup, connection, tool, timeout, and incomplete-shutdown errors are retained in the same bounded `raw/operations/runtime-diagnostics.jsonl` used by other runtime components. The TUI exposes only component, class, and artifact path; sanitized detail is kept out of agent context.

Each `(runID, profile)` controller processes ordinary browser mutations serially, but controllers for different AgentRuns run in parallel on the same hub and MCP cancellation is handled out of band. When the gateway deadline or caller aborts a request, it forwards the cancellation signal upstream; that controller consumes `notifications/cancelled` immediately, invalidates its browser epoch, closes only its owned tabs, suppresses the obsolete response, and releases its serial queue. If cleanup cannot settle within two seconds, only that controller exits. The gateway quarantines and recreates the controller in single-flight without replaying the interrupted action. Sibling controllers and the hub remain alive.

`runtime_status` reports and actively checks only the managed browser hubs and Ghidra MCP generations. Browser labels remain `browser-1` through `browser-5` and `browser-search`; controller run IDs never enter this public status surface. Call it with `action=status` to discover the labels active in the current phase, then pass one returned label to `action=check`. A label that is not active or not managed is rejected as non-retryable and points back to status discovery; it is never reported as a transport health failure.

Every owned launch disables browser-vendor background networking before the blank context starts, including Chrome Safe Browsing hash-prefix real-time key fetches and sample pings. This does not bypass target TLS or target-origin controls; it prevents a dedicated red-team profile from emitting unrelated vendor traffic through the engagement proxy before an agent navigates.

Numbered target profiles do not install an origin allowlist or abort cross-domain navigations, redirects, or subresources. This is deliberate because ordinary target journeys commonly depend on separate identity, CDN, API, payment, and telemetry origins. The agent-declared authorized hosts still scope shared ZAP rate-limit and mandatory public-header rules plus engagement records, but neither agents nor environment variables can turn that metadata into a browser navigation filter. The mission and persona remain the authority for allowed traffic.

Every browser result carries a redacted `_meta["cyberful.dev/browser-action"]` envelope with profile, owned tab ID as `page_id`, origin, path family, action family, page transition, outcome, and status when available. It excludes run identity, selectors, entered text, cookies, request bodies, and query values. Current scope is keyed in memory by `(runID, profile)` so concurrent tabs cannot overwrite one another's CAPTCHA routing. Durable numbered-profile coverage remains aggregated in `raw/operations/surface-coverage.jsonl` and the per-phase version 2 summary. Search events and their direct egress are excluded completely from target coverage.

The phase gateway also resolves and records the effective browser identity on every browser call. Omitting `browser_profile` means profile `1`; the default, explicit numbered profiles, and `search` are written to the metadata-only `raw/operations/tool-usage.csv` and returned in host-owned call metadata. Search rows carry route `browser/direct-search` but never the query or result content.
