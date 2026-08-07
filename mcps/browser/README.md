# browser MCP

Standalone stdio MCP server for browser-use style automation with an isolated Playwright Chromium on macOS.

Cyberful starts one instance per numbered browser identity and adds the gateway-only `profile` selector to the tools. A standalone MCP process still owns exactly one `CYBER_BROWSER_USER_DATA_DIR`.

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
- `browser_navigate`
- `browser_snapshot`
- `browser_captcha_status`
- `browser_captcha_handoff`
- `browser_click`
- `browser_fill`
- `browser_type`
- `browser_select`
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

Ordinary requests for one profile remain serialized. MCP cancellation bypasses that queue: a gateway timeout or caller abort immediately invalidates the active browser context, waits at most two seconds for Playwright cleanup, suppresses the stale response, and frees later requests from the blocked operation. A cleanup that still cannot settle terminates only that profile's MCP process; it cannot leave the profile queue waiting for the original operation indefinitely. The owning gateway then probes the quarantined generation and recreates that one profile in single-flight if its transport died. The cancelled target action is never replayed automatically.

## CAPTCHA/challenge handling

`browser_captcha_status` detects common CAPTCHA and anti-bot challenge signals such as reCAPTCHA, hCaptcha, Cloudflare Turnstile, Cloudflare challenge pages, Arkose/FunCaptcha, Geetest, and generic CAPTCHA markers. Provider SDK requests, response fields, and a lone generic CAPTCHA mention remain visible in its diagnostics, but do not count as an active challenge without stronger visible page evidence.

The agent first performs the ordinary page action that makes the challenge visible. `browser_captcha_handoff` then refuses unless detection attests that active challenge and brings the same Chromium window to the front. It returns immediately so the agent can call the gateway `question` tool with `kind: "captcha"`; that TUI question, not a short browser timeout, owns the human pause. After the answer, `browser_captcha_status` must attest that the challenge cleared. The scoped gateway circuit breaker denies further actions only for that browser profile and origin until that observation. Other profiles, origins, tabs, and non-browser tools continue. It never solves, bypasses, injects tokens, or automates CAPTCHA challenges. If the foregrounded browser has no visible challenge, the human can choose `No challenge visible` to clear that false-positive pause explicitly.

## Isolation

- Browser cache: `mcps/browser/.browsers`
- Profile: `~/.local/state/cyberful-os/mcp/browser/profile`
- Artifacts: `~/.local/state/cyberful-os/mcp/browser/artifacts`

Useful environment overrides:

- `CYBER_BROWSER_BROWSERS_PATH`
- `CYBER_BROWSER_USER_DATA_DIR`
- `CYBER_BROWSER_PROFILE_ID` as an integer from `1` through `5` reported by `browser_status`
- `CYBER_BROWSER_CLEAR_COOKIES_ON_START=true` to intentionally clear the persistent target login (default: preserve it)
- `CYBER_BROWSER_ARTIFACTS_DIR`
- `CYBER_BROWSER_HEADLESS=true`
- `CYBER_BROWSER_EXECUTABLE`
- `CYBER_BROWSER_PROXY`

`browser_status` reports the configured and resolved browser channel, actual browser version/driver, connection mode, and proxy state. In Recon, the host-owned EAGER browser attests these values after launch and each CDP-attached scout receives the same record before its first navigation.

For a sequential phase with a configured proxy, the first `browser_status` launches only the blank dedicated context and probes ZAP so it can return `zap` or `direct-fallback` before target traffic. An unattested CDP attachment stays `pending` because that process does not own the browser launch.
