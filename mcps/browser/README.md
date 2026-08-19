# browser MCP

Standalone stdio MCP server for browser-use style automation with an isolated Playwright Chromium on macOS.

Cyberful starts one lazy Chromium hub per numbered target identity plus one named `search` identity and adds the gateway-only `profile` selector to ordinary browser tools. Each AgentRun receives a separate CDP controller for a selected hub; a standalone MCP process still owns exactly one `CYBER_BROWSER_USER_DATA_DIR`. The `search` controller alone publishes `web_search`, which never accepts a profile argument.

## Install

From the repository root:

```sh
npm --prefix mcps install
npm --prefix mcps run browser:install
```

`browser:install` downloads Chromium into `browser/.browsers/`.

## Run

```sh
npm --prefix mcps run browser
```

Or directly:

```sh
mcps/browser/bin/cyber-browser
```

## Tools

- `browser_status`
- `browser_tabs`
- `web_search` (only when `CYBER_BROWSER_PROFILE_ID=search`)
- `browser_navigate`
- `browser_snapshot`
- `browser_captcha_status`
- `browser_captcha_handoff`
- `browser_click`
- `browser_fill`
- `browser_type`
- `browser_select`
- `browser_set_input_files`
- `browser_scroll`
- `browser_check`
- `browser_press`
- `browser_wait`
- `browser_artifact_list`
- `browser_artifact_read`
- `browser_network_log`
- `browser_network_response_body`
- `browser_evaluate`
- `browser_cookies`
- `browser_close`

## DOM snapshots

`browser_snapshot` returns at most 12,000 text characters and 80 actionable elements by default. For a long document, narrow the result with a CSS `selector`; text and refs then come only from the first matching subtree. Follow `next_text_offset` with `text_offset` to read subsequent character ranges without overlap or gaps. The result always reports scope, selector match count, `start-end/total`, truncation, and interactive-element counts.

Prefer the defaults plus selector/pagination before raising `max_text_chars` or `max_elements`. Their hard limits remain 100,000 and 500. Invalid selectors and selectors with no matches return explicit errors.

## Navigation waits

Use the default `wait_until="domcontentloaded"` for ordinary page opens. `browser_navigate` and post-click waits intentionally do not expose `networkidle`; modern retail, analytics-heavy, streaming, polling, or chat-widget pages may keep background requests open indefinitely. When you need readiness beyond DOM load, wait for a specific selector or text with `browser_wait`.

Use `browser_wait state="networkidle"` only when you explicitly need network quietness and are prepared for it to time out.

If a navigation commits but the requested load state times out, the tool returns the current page URL/title with a warning so the agent can continue with `browser_snapshot`, `browser_wait`, or `browser_captcha_status`.

Ordinary requests are serialized per `(AgentRun, profile)` controller, while different AgentRuns may operate concurrently on the same profile hub. MCP cancellation bypasses one controller queue: a gateway timeout or caller abort invalidates that controller's active browser epoch, closes only its owned tabs, suppresses the stale response, and frees later requests from the blocked operation. The hub and sibling controllers remain alive. A dead controller is recreated in single-flight and the cancelled target action is never replayed automatically.

## AgentRun tabs

`browser_tabs` accepts `action: "list" | "open" | "select" | "close"`; `tab_id` is required for `select` and `close`. Results contain only tabs owned by the calling controller. `open` creates a blank active tab, popup pages inherit ownership, and a page-scoped action after the last owned tab closes creates a fresh one lazily. `browser_status` reports only those tabs with `active_tab_id`, URL, and title, plus the shared profile launch state. Foreign and stale tab IDs are indistinguishable and return a nonexistent-tab error.

DOM state, snapshot refs, active page, network logs, and response-body IDs are controller-local. Cookies, local storage, service workers, authentication, downloads, and the artifact directory remain shared inside one profile. Closing an AgentRun closes all of its tabs without closing Chromium or sibling tabs.

## DuckDuckGo search

`web_search` uses Chromium to load DuckDuckGo's official HTML surface, extracts one bounded page of organic and sponsored results, unwraps DuckDuckGo redirect URLs, and fails explicitly on an unknown layout or visible challenge. It performs no automatic retry. Cyberful forces the tool to the direct, persistent `search` profile; ordinary browser tools may also select that identity with `profile: "search"`.

## CAPTCHA/challenge handling

`browser_captcha_status` detects common CAPTCHA and anti-bot challenge signals such as reCAPTCHA, hCaptcha, Cloudflare Turnstile, Cloudflare challenge pages, Arkose/FunCaptcha, Geetest, and generic CAPTCHA markers. Provider SDK requests, response fields, and a lone generic CAPTCHA mention remain visible in its diagnostics, but do not count as an active challenge without stronger visible page evidence.

The agent first performs the ordinary page action that makes the challenge visible. `browser_captcha_handoff` then refuses unless detection attests that active challenge and brings the same Chromium window to the front. It returns immediately so the agent can call the gateway `question` tool with `kind: "captcha"`; that TUI question, not a short browser timeout, owns the human pause. After the answer, `browser_captcha_status` must attest that the challenge cleared. The version 2 gateway circuit-breaker file retains multiple entries scoped by AgentRun, profile, tab, and origin and reads the former single-entry state as a legacy wildcard owner. Other AgentRuns, profiles, origins, tabs, and non-browser tools continue. It never solves, bypasses, injects tokens, or automates CAPTCHA challenges. If the foregrounded browser has no visible challenge, the human can choose `No challenge visible` to clear that false-positive pause explicitly.

## Isolation

- Browser cache: `mcps/browser/.browsers`
- Profile: `~/.local/state/cyberful-os/mcp/browser/profile`
- Artifacts: `~/.local/state/cyberful-os/mcp/browser/artifacts`

Useful environment overrides:

- `CYBER_BROWSER_BROWSERS_PATH`
- `CYBER_BROWSER_USER_DATA_DIR`
- `CYBER_BROWSER_PROFILE_ID` as an integer from `1` through `5` or `search`, reported by `browser_status`
- `CYBER_BROWSER_CLEAR_COOKIES_ON_START=true` to intentionally clear the persistent target login (default: preserve it)
- `CYBER_BROWSER_ARTIFACTS_DIR`
- `CYBER_BROWSER_HEADLESS=true`
- `CYBER_BROWSER_EXECUTABLE`
- `CYBER_BROWSER_PROXY`

`browser_status` reports the configured and resolved browser channel, actual browser version/driver, connection mode, proxy state, `active_tab_id`, and only the calling controller's pages. The host-owned EAGER hub attests shared launch values and each CDP-attached AgentRun controller receives the same record.

For an eligible phase, the first page use launches the dedicated hub and probes ZAP so shared status can return `zap` or `direct-fallback` before target traffic. The gateway exposes `browser_close` only to the original phase root; it closes every controller and the selected hub, and later use may recreate them lazily. Subagents and fallbacks close only their own tabs through `browser_tabs`.
