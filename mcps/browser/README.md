# Browser runtime

Cyberful uses its [agent-browser fork](https://github.com/cyberful/agent-browser) `0.34.0-cyberful.3` as its only browser automation runtime. The `bin/cyber-browser` compatibility launcher resolves the package's platform-native executable and always starts MCP mode with the complete typed catalog (`mcp --tools all`).

Cyberful, rather than the launcher, owns profile selection, session and namespace names, daemon sockets, lifecycle, and target egress. The gateway creates one shared agent-browser session per profile and phase. Persistent profiles `1` through `5` retain authenticated Chrome state and fail closed unless ZAP and its CA are available; the ephemeral `search` context is direct, carries no Cyberful proxy environment, and is natively confined to `*.duckduckgo.com` and `*.google.com`.

`web_search` is a Cyberful gateway wrapper over agent-browser on `search`. It is the canonical public-search operation. Authorized `agent_browser_*` tools remain available through deferred tool discovery; calls on `search` can interact only with DuckDuckGo or Google, while authorized target browsing uses a numbered ZAP-routed profile. The first operational browser result from `tool_search` automatically includes agent-browser's version-matched `core-mcp-managed` instructions; narrower specialized skills remain available through `agent_browser_skills_list` and `agent_browser_skills_get`.

Install dependencies and Chrome from the repository root:

```sh
npm install --prefix mcps
npm run --prefix mcps browser:install
```

The pinned package supplies native executables, skill data, and its Apache-2.0 license. Release builds embed only the native executable matching the target platform together with the package data required at runtime and the first-party CAPTCHA plugin.

## Hardened fork

The fork owns Chrome launch and CDP hardening directly. It never enables the detectable CDP Runtime domain, suppresses the AutomationControlled Blink feature, and provides `AGENT_BROWSER_PASSIVE=1` for headed human login without page attachment. Cyberful uses that passive mode for `cyberful browser-1` through `browser-5`, fixes `--restore-last-session` for every numbered-profile launch so clean restarts retain session cookies, and leaves the temporary `search` profile unrestored. Existing tabs remain untouched and no temporary tab is opened for login-state collection. Closing Chrome also exits the passive daemon, and the Cyberful command waits until the profile lock has been released.

Target proxy, bypass, CA SPKI, and QUIC policy remain host-owned environment. Nested batch, provider, or model arguments cannot replace ZAP routing or the search allowlist, while `search` receives no proxy values or persistent Chrome profile. Browser-global header mutation is hidden and rejected because mandatory public program headers belong to the host-owned ZAP route. `CYBER_BROWSER_CHROME_EXECUTABLE` remains the optional operator override.

## First-party CAPTCHA plugin

`bin/agent-browser-plugin-captcha` implements `agent-browser.plugin.v1` and publishes `command.run` plus `captcha.solve`. Cyberful fixes this plugin in every profile registry, blocks `plugin add`, and permits plugin execution only for `captcha/captcha.solve`. The plugin maps bounded Turnstile, reCAPTCHA v2/v3, hCaptcha, image-to-text, or provider-native tasks onto the documented CapSolver and 2Captcha create/result APIs.

Configure it through Cyberful's private gateway environment:

```dotenv
CYBER_BROWSER_CAPTCHA_PROVIDER=capsolver
CYBER_BROWSER_CAPTCHA_API_KEY=replace-with-provider-key
```

The provider accepts `auto`, `capsolver`, or `2captcha`. Without credentials the installed plugin returns a structured failure and the agent may use Cyberful's human CAPTCHA question as a last resort. API keys are never accepted in the plugin request payload or returned in its output.

Run the browser package checks with:

```sh
npm run --prefix mcps test:browser
```
