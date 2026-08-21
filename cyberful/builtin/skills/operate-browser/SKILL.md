---
name: operate-browser
description: Operate Cyberful's agent-browser profiles for public research, authenticated target journeys, evidence capture, downloads, and ZAP-observed application testing. Use before calling web_search or agent_browser tools in Pentest or Bug Bounty phases.
metadata:
  domain: security-tooling
  subdomain: browser-operations
  triggers:
    - agent-browser operation
    - authenticated browser journey
    - browser profile comparison
    - browser evidence capture
    - public web research
  tags:
    - agent-browser
    - authenticated-session
    - multi-profile
    - evidence-capture
    - ZAP-proxy
  frameworks: {}
---

# Operate Browser

Use agent-browser as a stateful evidence surface. This skill is Cyberful's host-policy overlay; it does not replace agent-browser's operational contract or expand mission authority.

## Combine host policy with the managed MCP contract

When `tool_search` first loads an operational `agent_browser_*` tool, Cyberful atomically loads agent-browser's version-matched `core-mcp-managed` skill in the same AgentRun. It is not part of the initial prompt and does not load for `web_search` alone. Do not load the CLI-oriented `core` skill inside Cyberful.

Use the managed upstream skill for typed browser operations and this overlay for Cyberful profiles, authorization, ZAP, secrets, shared-state constraints, evidence, and lifecycle. Load a narrower upstream skill manually only when its specialized workflow is required.

## Select the route and identity

- Use numbered profiles `1` through `5` only for target identities explicitly supplied or assigned by the operator. Always pass `profile` explicitly when identity matters and preserve the identity-to-profile assignment throughout the phase.
- Numbered profiles are persistent, shared within the phase, and routed through ZAP. If ZAP, its CA, the selected profile, or the browser process is unavailable, stop that browser path; never fall back to a direct target connection.
- Use `web_search` for public discovery. It always uses the temporary direct `search` profile and returns structured DuckDuckGo results. Direct `agent_browser_*` calls with `profile: "search"` may access only DuckDuckGo or Google search pages.
- The host fixes the `search` network allowlist to `*.duckduckgo.com` and `*.google.com`; the wildcard semantics include each bare domain. Navigations, redirects, subresources, sockets, workers, beacons, and WebRTC cannot reach any other host, and model arguments cannot widen the list. Use a numbered ZAP-routed profile for every authorized target or selected result that requires browser inspection.
- Never copy cookies, storage, tokens, headers, or other session material between profiles. Use different numbered profiles for different identities.

## Respect shared browser state

A profile has one phase-shared agent-browser session, so its state is visible to root, delegated, and fallback AgentRuns. Inspect tabs before changing state, avoid disrupting unrelated work, and close only temporary tabs you created.

Snapshot refs are ephemeral. Take a new `agent_browser_snapshot` before using a ref, after navigation or any state-changing action, and whenever another AgentRun may have changed the shared page. Never reuse a ref merely because its label still sounds correct.

Cyberful owns session, namespace, persistent profile, proxy, connection, and lifecycle. Do not change reserved parameters, attach a numbered profile to external CDP/providers, or close it. After cancellation, inspect state instead of repeating an uncertain mutation.

## Handle secrets and authentication

Store every supplied secret with `variable` before browser input. Pass the exact saved identifier as `{{var:<saved-name>}}`; the host resolves it after the model boundary. Never read a saved value back, expose it in narration or artifacts, paste it into another tool call, or recover it from browser evidence. In durable documents, use only neutral `[session-variable:<saved-name>]` identifiers.

Complete ordinary login autonomously for an explicitly supplied account when stored access is sufficient. Confirm it from visible UI and record only required non-secret identity state. Do not copy sessions across profiles or treat a redirecting identity provider as a separate target.

Handle a visible CAPTCHA autonomously first. Snapshot and inspect it; use ordinary actions when visible evidence is sufficient. For token challenges, confirm `captcha` with `agent_browser_plugin_show`, then call `agent_browser_plugin_run` using `name: "captcha"`, `requestType: "captcha.solve"`, and payload fields `kind`, `url`, `siteKey`, plus required `action`, `cdata`, or `pageData`. Never include an API key. Apply the solution through the page widget or callback, snapshot, and verify acceptance; never infer success or purchase the same solution twice.

Use `question kind=captcha` only when autonomous interaction is insufficient and the solver is unconfigured, fails, or returns a rejected solution with no bounded correction. Preserve the tab; after human resolution, snapshot again. Never switch profile, proxy, CDP, or route to evade the challenge.

## Run the Brief readiness preflight

Run this bounded preflight only for accounts explicitly assigned to numbered target profiles. The required `engagement_policy configure` must succeed before the first numbered-profile target navigation.

For each supplied numbered profile:

1. Open only the supplied normal entry point with `agent_browser_open`; an unavailable ZAP route or locked profile must produce an explicit blocker rather than direct fallback.
2. Complete ordinary login when necessary and take a fresh snapshot.
3. Confirm from visible target UI that the session is authenticated and, when multiple identities were promised, that profiles are visibly distinct.
4. Ask the human only when a human factor, rejected or locked access, unavailable profile, or degraded proxy prevents readiness. In Brief, retry only the failed readiness check after repair; decline or cancellation leaves the profile `BLOCKED`.
5. Use ZAP for durable HTTP evidence and passive dependency inventory produced by this normal journey.

This is one ordinary readiness journey, not reconnaissance or a security test. Do not declare access ready unless authentication, identity distinctness, and the required ZAP-routed load are evidenced.

## Collect evidence through the canonical flow

For public research, use `web_search` and retain the minimum structured result evidence needed. If additional search-page interaction is necessary, use agent-browser on `search` only for DuckDuckGo or Google. Do not open a result host on `search`; use an authorized numbered ZAP-routed profile when target inspection is in scope. A search failure or challenge is a bounded wrapper error; do not bypass the host allowlist.

For target work, use the visible product journey and the least surprising browser action that expresses the intended user behavior. Save required screenshots, downloads, ZAP facts, and durable artifacts before handoff. Treat automatically contacted APIs, CDNs, identity services, and third parties as dependency observations rather than new testing targets. Before using `zap_*` tools or resources, load and follow the `operate-zap` skill.
