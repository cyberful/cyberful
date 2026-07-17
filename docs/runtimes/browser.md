# Browser MCP

The browser MCP drives an isolated, headed Chromium profile by default and
exposes structured DOM, page, network, cookie, and artifact operations. It does
not provide screenshot or vision tools and does not solve CAPTCHAs.

The installed binary downloads open-source Chromium on first use and stores it
in the Cyberful cache. To reuse an explicitly prepared Google Chrome profile for
an authorized target, set in the launch directory's `.env`:

```dotenv
CYBER_BROWSER_CHANNEL=chrome
CYBER_BROWSER_USER_DATA_DIR=/absolute/path/to/dedicated-profile
```

Fully close the seeded browser before Cyberful starts so its profile lock is
released. Never point Cyberful at a personal daily-use profile. Chromium is the
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
