# Browser MCP

The browser MCP drives up to five isolated, headed Chromium profiles and exposes
structured DOM, page, network, cookie, and artifact operations. It does not
provide screenshot or vision tools and does not solve CAPTCHAs. Every
`browser_*` tool accepts an optional integer `profile` from `1` through `5`;
omitting it selects profile 1.

Browser discovery and dispatch share one registry: duplicate names or a tool
without an object schema and handler stop startup before Chromium is launched.

## Bounded DOM snapshots

`browser_snapshot` defaults to 12,000 visible-text characters and 80 actionable
elements. Keep those defaults for the first read. On long pages, pass a CSS
`selector` to confine both text and actionable refs to the first matching
subtree, then use the returned `next_text_offset` as `text_offset` for later
non-overlapping slices. Increase `max_text_chars` or `max_elements` only when
scoping and pagination are insufficient; the hard limits remain 100,000
characters and 500 elements.

Every result reports the selected scope, selector match count, text interval
`start-end/total`, next offset when more text exists, returned and total
interactive-element counts, and separate text/element truncation flags. Refs
are generated only for interactive descendants of the selected scope. An
invalid selector or a selector with no matches returns an explicit tool error.
When several nodes match, text and refs come from the first and the result
retains the total match count so the caller can refine the selector.

Each number owns separate cookies, local storage, cache, tabs, downloads, and a
Chromium profile lock. This makes role-to-role and tenant-to-tenant comparisons
possible without moving session tokens between accounts. A mission can say, for
example, "profile 1 contains the buyer and profile 2 the seller"; Cyberful maps
those identities to `profile: 1` and `profile: 2` on every browser call.

## Pre-authenticate profiles manually

From the repository root, open the identity you want to seed:

```sh
make browser-run-1
make browser-run-2
# ...through make browser-run-5
```

Sign in only to the authorized target account for that identity, then fully
close the Chromium window. The Make command returns after the browser exits and
releases its profile lock. Repeat for other accounts, then run Cyberful and tell
it which account is stored in each numbered profile. Do not leave a manual
profile open when starting Cyberful: a locked profile is replaced with a
temporary unauthenticated fallback for that run rather than risking corruption.

The default persistent locations are
`~/.cyberful/browser/profiles/cyberful` for profile 1 and
`~/.cyberful/browser/profiles/cyberful-2` through `cyberful-5` for the remaining
identities. Never point any profile at a personal daily-use browser directory.

The installed binary downloads open-source Chromium on first use and stores it
in the Cyberful cache. To use real Google Chrome for all five identities, or
override one explicitly prepared profile, set values in the launch directory's
`.env`:

```dotenv
CYBER_BROWSER_CHANNEL=chrome
CYBER_BROWSER_USER_DATA_DIR_2=/absolute/path/to/dedicated-profile-2
```

`CYBER_BROWSER_USER_DATA_DIR` remains the compatibility override for profile 1;
`CYBER_BROWSER_USER_DATA_DIR_1` through `_5` are the numbered overrides and take
precedence. Matching `CYBER_BROWSER_ARTIFACTS_DIR_1` through `_5` values can
override each download directory. Fully close every seeded browser before
Cyberful starts so its profile lock is released. Chromium is the
distribution-safe default; `CYBER_BROWSER_CHANNEL=auto` prefers Chrome when it
is installed.

Key controls include `CYBER_BROWSER_HEADLESS`,
`CYBER_BROWSER_CLEAR_COOKIES_ON_START`, `CYBER_BROWSER_ARTIFACTS_DIR`,
`CYBER_BROWSER_STEALTH`, and `CYBERFUL_SKIP_BROWSER_PREFLIGHT`. When ZAP proxying
is enabled, the host injects the loopback proxy and trust pin; users should not
manually supply its API keys.

A visible CAPTCHA is handed to the human through the TUI while the challenged
page is preserved and foregrounded. The breaker is limited to that browser
profile and origin; other profiles, origins, tabs, and non-browser tools keep
working. Provider SDK traffic, response fields, and a lone generic CAPTCHA
mention remain diagnostic signals but do not, by themselves, count as a
visible challenge or open a handoff. After checking the foregrounded browser,
the human can choose:

- `Resolved` after completing a visible challenge; Cyberful then verifies the
  original page with `browser_captcha_status`;
- `No challenge visible` to clear a false-positive pause explicitly;
- `Cannot resolve` to keep that profile and origin paused.

Cyberful never solves the challenge, injects a bypass token, or interprets
ordinary session steering as one of these decisions.

Browser gateway startup, connection, tool, timeout, and incomplete-shutdown
errors are retained in the same bounded
`raw/operations/runtime-diagnostics.jsonl` used by other runtime components.
The TUI exposes only component, class, and artifact path; sanitized detail is
kept out of agent context.

Every browser result carries a redacted `_meta["cyberful.dev/browser-action"]`
envelope with profile, page ID, origin, path family, action family, page
transition, outcome, and status when available. It excludes selectors, entered
text, cookies, request bodies, and query values. The gateway stores these events
locally in `raw/operations/surface-coverage.jsonl` and publishes a per-phase
version 2 summary. Browser and egress envelopes from the same call are both
retained; the summary groups methods, HTTP statuses, and outcomes per route and
lists a route under `failed_only` only when it has no successful observation.

The phase gateway also resolves and records the effective browser identity on
every browser call. Omitting `browser_profile` means profile `1`, and both that
default and explicit profiles are written to `raw/operations/tool-usage.csv`
and returned in host-owned call metadata.
