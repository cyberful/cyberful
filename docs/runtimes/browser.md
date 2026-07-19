# Browser MCP

The browser MCP drives up to five isolated, headed Chromium profiles and exposes
structured DOM, page, network, cookie, and artifact operations. It does not
provide screenshot or vision tools and does not solve CAPTCHAs. Every
`browser_*` tool accepts an optional integer `profile` from `1` through `5`;
omitting it selects profile 1.

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

A visible CAPTCHA may be handed to the human through the TUI. Active browser
tools remain blocked until the challenge is visibly cleared; Cyberful never
injects a bypass token.
