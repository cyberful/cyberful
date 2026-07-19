# browser MCP

Standalone stdio MCP server for browser-use style automation with an isolated
Playwright Chromium on macOS.

Cyberful starts one instance per numbered browser identity and adds the
gateway-only `profile` selector to the tools. A standalone MCP process still
owns exactly one `CYBER_BROWSER_USER_DATA_DIR`.

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

## Navigation waits

Use the default `wait_until="domcontentloaded"` for ordinary page opens.
`browser_navigate` and post-click waits intentionally do not expose
`networkidle`; modern retail, analytics-heavy, streaming, polling, or
chat-widget pages may keep background requests open indefinitely. When you need
readiness beyond DOM load, wait for a specific selector or text with
`browser_wait`.

Use `browser_wait state="networkidle"` only when you explicitly need network
quietness and are prepared for it to time out.

If a navigation commits but the requested load state times out, the tool returns
the current page URL/title with a warning so the agent can continue with
`browser_snapshot`, `browser_wait`, or `browser_captcha_status`.

## CAPTCHA/challenge handling

`browser_captcha_status` detects common CAPTCHA and anti-bot challenge signals
such as reCAPTCHA, hCaptcha, Cloudflare Turnstile, Cloudflare challenge pages,
Arkose/FunCaptcha, Geetest, and generic CAPTCHA markers.

The agent first performs the ordinary page action that makes the challenge
visible. `browser_captcha_handoff` then refuses unless detection attests that
active challenge and brings the same Chromium window to the front. It returns
immediately so the agent can call the gateway `question` tool with
`kind: "captcha"`; that TUI question, not a short browser timeout, owns the
human pause. After the answer, `browser_captcha_status` must attest that the
challenge cleared. The engagement-wide gateway circuit breaker denies other
active tools and handoff until that observation. It never solves, bypasses,
injects tokens, or automates CAPTCHA challenges.

## Isolation

- Browser cache: `mcps/browser/.browsers`
- Profile: `~/.local/state/cyberful-os/mcp/browser/profile`
- Artifacts: `~/.local/state/cyberful-os/mcp/browser/artifacts`

An engagement can additionally set `CYBER_BROWSER_ALLOWED_ORIGINS` to a JSON
string array of exact origins, for example
`["https://app.example.test","https://api.example.test","wss://api.example.test"]`.
When present, the browser blocks HTTP(S) requests, redirects, subresources, and
WS(S) connections whose canonical origin is not listed. Scheme, host, and port
must match; entries cannot contain credentials, paths, queries, fragments, or
wildcards. Chromium contexts launched under this policy also block service
workers so they cannot bypass Playwright routing. `about:blank`, `about:srcdoc`,
and `data:` documents remain available for browser internals; a `blob:` URL is
accepted only when its inherited origin is listed.

Useful environment overrides:

- `CYBER_BROWSER_BROWSERS_PATH`
- `CYBER_BROWSER_USER_DATA_DIR`
- `CYBER_BROWSER_PROFILE_ID` as an integer from `1` through `5` reported by `browser_status`
- `CYBER_BROWSER_CLEAR_COOKIES_ON_START=true` to intentionally clear the persistent target login (default: preserve it)
- `CYBER_BROWSER_ARTIFACTS_DIR`
- `CYBER_BROWSER_HEADLESS=true`
- `CYBER_BROWSER_EXECUTABLE`
- `CYBER_BROWSER_PROXY`
- `CYBER_BROWSER_ALLOWED_ORIGINS` as a private JSON string array of exact HTTP(S)/WS(S) origins

`browser_status` reports the configured and resolved browser channel, actual
browser version/driver, connection mode, and proxy state. In Recon, the
host-owned EAGER browser attests these values after launch and each CDP-attached
scout receives the same record before its first navigation.

For a sequential phase with a configured proxy, the first `browser_status`
launches only the blank dedicated context and probes ZAP so it can return `zap`
or `direct-fallback` before target traffic. An unattested CDP attachment stays
`pending` because that process does not own the browser launch.
