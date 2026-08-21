# agent-browser runtime

Cyberful embeds [the Cyberful agent-browser fork 0.34.0-cyberful.3](https://github.com/cyberful/agent-browser) and exposes its authorized typed MCP surface as `agent_browser_*` tools. Five numbered target profiles are routed through the engagement-owned ZAP proxy. A separate `search` profile is direct, ephemeral, credential-free, and host-confined to DuckDuckGo and Google. Every browser tool accepts the gateway-owned `profile` selector when more than one profile is available; omission selects the lowest available numbered profile, or `search` when it is the only candidate.

The builtin `operate-browser` skill is the Cyberful overlay for profile routing, authorization, ZAP, stored variables, shared state, evidence, CAPTCHA handling, and lifecycle. It does not duplicate agent-browser's operational guide. When `tool_search` first discovers an operational browser tool, the Pi bridge retrieves, validates, and returns the version-matched upstream `core-mcp-managed` skill before adding that tool to the AgentRun. The bundle is loaded once per root, subagent, or fallback context, is absent from the initial prompt, and is not loaded by `web_search` alone.

## Catalog and loading

Cyberful discovers all 152 definitions once per phase through paginated `tools/list` on the direct `browser-search` identity, using the same pinned binary and first-party plugin set as the numbered profiles. It publishes the 117 definitions that have an executable Cyberful route and omits 35 tools whose credential storage, connection, configuration, extension, state, header, or lifecycle behavior is entirely host-owned. The immutable effective catalog is then reused for all six managed identities instead of starting six short-lived discovery processes. Duplicate names, malformed schemas, repeated cursors, or an incomplete profile catalog stop browser publication. `web_search` is eager. The effective `agent_browser_*` catalog remains deferred behind `tool_search`, so each AgentRun loads only the operations it needs.

The gateway removes fields that could replace Cyberful's allowed domains, session, namespace, persistent profile, proxy, daemon, browser provider, CDP attachment, plugins, or lifecycle. Tools that exist only to replace those host-owned decisions are absent from `tools/list`; the execution boundary retains the same denials as defense in depth. Browser-global header mutation is also unavailable: mandatory public program headers are installed only by the host in ZAP so they cannot enter browser CORS preflights. Brief publishes only ordinary readiness navigation, observation, interaction, tab, file, and CAPTCHA operations. The only callable plugin request is Cyberful's first-party `captcha/captcha.solve` operation.

## Profiles and shared state

Profiles 1 through 5 use persistent directories beneath `~/.cyberful/browser/profiles/` and persistent artifact directories beneath `~/.cyberful/browser/artifacts/`. Each profile owns one phase-shared agent-browser MCP process, daemon session, namespace, and active browser state. Root, delegated, and fallback AgentRuns deliberately share that profile's tabs, cookies, storage, snapshot state, downloads, and current page. Calls are serialized per profile and can proceed in parallel across profiles. On Unix, the host derives fixed-length phase-, process-, and profile-specific session and namespace names so the complete daemon endpoint remains within the platform socket-path limit even when Cyberful session IDs are long.

This shared state makes authenticated collaboration possible but also makes snapshot refs ephemeral. Inspect tabs before changing state, take a fresh snapshot before using refs and after navigation or mutations, avoid disrupting another actor's work, and close only temporary tabs you created. Cyberful supplies the same host-owned session and namespace to every call; it does not attribute individual ZAP requests to an AgentRun or browser profile.

The `search` identity runs in a fresh phase-ephemeral browser context with ZAP proxy variables, target trust, persistent Chrome profile state, and restoration removed. The host fixes agent-browser's native allowlist to the two patterns `*.duckduckgo.com` and `*.google.com`; each wildcard includes the bare domain. The fork blocks every other navigation, redirect, subresource, WebSocket, EventSource, beacon, and worker path and disables WebRTC while containment is active. The model-visible `allowedDomains` field is removed, so no call can widen the list. `web_search` uses this identity automatically; direct `agent_browser_*` calls may select it only for DuckDuckGo or Google search pages. Search activity and direct search egress never enter target coverage or satisfy a target-profile readiness requirement.

## Pre-authenticate target profiles

Open a dedicated numbered identity before an engagement:

```sh
cyberful browser-1
cyberful browser-2
# ...through cyberful browser-5
```

Sign in only to the authorized target account assigned to that profile, then fully close the browser before starting Cyberful. The manual command remains an agent-browser launch and uses the fork's passive human-login mode. agent-browser owns the Chrome process but performs no page-target attachment, navigation, inspection, or agent-browser state replay, so restored tabs remain untouched instead of being reset to `about:blank`. Cyberful fixes Chrome's `--restore-last-session` argument for numbered profiles: Chrome would otherwise delete session cookies on the next clean startup even though it wrote them to the persistent cookie database. Closing the owned Chrome process ends the passive daemon; the Cyberful command waits for that exit so the socket and persistent profile lock are released before it returns. The manual command and phase runtime use the same persistent directory and the same Chrome session-restoration policy. Never point a Cyberful profile at a personal daily-use browser directory.

The default profile-one path can be overridden with `CYBER_BROWSER_USER_DATA_DIR`; numbered `CYBER_BROWSER_USER_DATA_DIR_1` through `_5` values take precedence. Matching `CYBER_BROWSER_ARTIFACTS_DIR_1` through `_5` values override artifact directories. `CYBER_BROWSER_HEADLESS` controls phase launches. Numbered profiles persist cookies, localStorage, IndexedDB, service workers, cache, and login state through their Chrome user-data directory. The fork allocates a non-zero loopback debugging port for passive login, suppresses `AutomationControlled`, removes launch flags that diverge unnecessarily from normal Chrome, and never sends `Runtime.enable` on page or temporary storage targets. This directly addresses the signals behind [agent-browser's upstream Google-login failure](https://github.com/vercel-labs/agent-browser/issues/271) without a relay or page-script fingerprint forgery. Console and uncaught page-error history are intentionally unavailable in the hardened build; targeted evaluation, DOM evidence, network capture, and ZAP remain available. Site-specific risk engines may still refuse a session independently. `CYBER_BROWSER_CHROME_EXECUTABLE` can select another operator-installed Chrome-compatible executable when the default resolution is unsuitable.

Manual profile seeding uses Chrome's native session restoration but no agent-browser restore snapshot. A target phase applies the same native restoration policy and additionally owns a namespace-local restore snapshot so cancellation can recreate its daemon without losing session cookies, but sets `AGENT_BROWSER_AUTOSAVE_INTERVAL_MS=0`: state is saved only during controlled shutdown, avoiding the periodic temporary origin tabs created by agent-browser's storage collector. `search` remains temporary and receives neither restoration mechanism. Source and release builds resolve the same fork binary and profile state; release binaries embed the pinned native executable, versioned skill data, license, and first-party CAPTCHA plugin.

## ZAP route and lifecycle

Every numbered profile requires the active ZAP proxy and the attested engagement CA SPKI before its MCP process can connect. The host injects agent-browser proxy, CA SPKI, bypass, and QUIC settings directly into the fork's local Chrome launch. A target profile never falls back to a direct connection when ZAP or trust is unavailable. The mission remains the authorization boundary: Cyberful does not turn `authorized_http_hosts` into a browser navigation allowlist because ordinary product journeys may require identity, API, CDN, payment, and other passive dependencies.

Catalog discovery on `browser-search` does not launch Chromium and cannot be blocked by numbered-profile ZAP readiness. The first operation lazily starts the selected profile's daemon. `runtime_status action=status` lists active labels such as `browser-1` and `browser-search`; `action=check` probes only a returned managed label. ZAP is not a reconnectable `runtime_status` label.

Calls carry their MCP cancellation signal into agent-browser. If cancellation interrupts an operation, Cyberful resets that profile's MCP generation and closes its daemon before allowing a later generation. The interrupted action is never replayed automatically. A normal AgentRun completion releases its host ownership record but does not destroy the phase-shared browser session. Gateway shutdown closes every profile process and daemon before the next phase begins.

## Public search

`web_search` opens DuckDuckGo's non-JavaScript HTML surface in a temporary search tab, extracts up to 20 labelled organic or sponsored results, closes the temporary tab, and restores the previous search tab when possible. It accepts a 1–500 character query, a `safe_search` level, and a bounded timeout. It makes at most one bounded fallback from the HTML surface to the Lite surface and never turns a visible challenge or unknown layout into a fabricated empty result. Google remains an allowed search-engine destination for direct search-profile interaction, but the wrapper does not silently switch engines.

Use `web_search` for discovery. Opening a selected result on any other host requires an authorized numbered profile routed through ZAP; the search profile cannot be used as a direct target bypass. Public sources do not expand engagement scope and do not replace retained target evidence.

## CAPTCHA plugin

When a visible challenge appears, inspect it first and attempt ordinary browser interaction when appropriate. For a supported token challenge, inspect the configured `captcha` plugin and call `agent_browser_plugin_run` with `name: "captcha"`, `requestType: "captcha.solve"`, and the non-secret challenge fields. Provider credentials remain in the plugin process and must never be passed in tool arguments. Apply the solution, take a fresh snapshot, and verify acceptance.

Use `question kind=captcha` only when the autonomous path is unavailable or fails. The browser session remains available for the human action. A generic mention of CAPTCHA in logs or content is not proof of a visible challenge.

The bundled `agent-browser-plugin-captcha` `0.1.0` supports bounded Turnstile, reCAPTCHA v2/v3, hCaptcha, image-to-text, and provider-native CapSolver or 2Captcha tasks. Configure `CYBER_BROWSER_CAPTCHA_PROVIDER=auto|capsolver|2captcha` and `CYBER_BROWSER_CAPTCHA_API_KEY` in the launch directory's private `.env`. Keys are read only by the plugin process, never accepted in the model payload, and never returned. When no key is configured the plugin remains discoverable and returns the structured failure that permits human fallback.

## Coverage metadata

The gateway classifies each agent-browser result into one semantic activity:

- `navigation`: open/read URL, new tab, back, forward, reload, or pushstate;
- `ui_interaction`: click, double-click, select, check, drag, dialog, mouse/touch, and equivalent `find` actions;
- `ui_input`: fill, type, press, keyboard input, or upload;
- `script`: page evaluation;
- `observation`: snapshot, screenshot, get/is, audit, wait, diagnostics, and other read-only operations.

`batch` is one compound activity. Cyberful does not pretend to correlate its internal commands with individual HTTP requests. The activity record contains only the numbered profile, opaque tab ID, action family, outcome, and current HTTP(S) origin when an explicit input or trusted result supplies it. Command names, selectors, entered text, cookies, headers, bodies, queries, and browser response content are excluded. Search is excluded completely.

Browser activity is not an HTTP map. The phase gateway incrementally reads passive ZAP history for canonical origin, redacted route family, method, status, and response presence. It never probes a hidden URL after a click and never derives route, method, or status from agent-browser when ZAP is available. The version-3 coverage ledger and summaries are documented in the [workflow guide](../user-guide/workflows.md) and [ZAP runtime](zap.md).

Recon requires one successful current-phase navigation, interaction, input, or script action on the configured origin for every profile marked `READY + IN_SCOPE`. Brief activity no longer satisfies that condition. Observation-only activity does not satisfy it, and there is no click or route quota.

## Evidence and diagnostics

Use agent-browser screenshots, downloads, PDFs, HARs, traces, and recordings only when they improve a bounded discriminator, and preserve necessary artifacts in the workarea before handoff. An explicit relative screenshot path may name nested workarea directories; the gateway and native screenshot writer create missing parents before saving. Browser response content is not copied into the coverage ledger.

Browser startup, connection, tool, cancellation, and shutdown failures append sanitized rows to `raw/operations/runtime-diagnostics.jsonl`. The MCP adapter registers an owned child PID immediately after spawn and preserves the runtime label, exact command, and bounded stderr when initialization or a later operation closes the connection, including failures that occur before the MCP handshake completes. Tool usage records the resolved browser profile but not search queries, inserted values, cookies, or target bodies. A coverage collector failure is a separate non-blocking degradation and never changes a successful browser action into an error.
