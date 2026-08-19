---
name: operate-browser
description: Operate Cyberful's isolated browser for public research, ordinary authenticated journeys, multi-profile comparisons, form interaction, evidence capture, downloads, and passive dependency observation. Use before calling browser tools in Pentest or Bug Bounty phases, especially for numbered target profiles, stored-variable login, CAPTCHA handoff, ZAP-routed readiness checks, or the direct search profile.
metadata:
  domain: security-tooling
  subdomain: browser-operations
  triggers:
    - isolated browser operation
    - authenticated browser journey
    - browser profile comparison
    - browser evidence capture
    - CAPTCHA handoff
  tags:
    - browser
    - authenticated-session
    - multi-profile
    - evidence-capture
    - ZAP-proxy
  frameworks: {}
---

# Operate Browser

Use the isolated browser as a stateful evidence surface. This skill governs browser operation; it does not authorize a target, effect, identity, or test that the mission and active phase do not already permit.

## Select the route and identity

- Use numbered profiles `1` through `5` only for target identities explicitly supplied or assigned by the operator. Pass the profile explicitly whenever identity matters; omission selects profile `1` but must not silently choose an actor.
- Use `profile: "search"` and `web_search` only for credential-free public research. `search` is intentionally direct with `proxy.configured=false` and `proxy.mode=direct`; it is not a target identity, readiness prerequisite, engagement-policy profile, or source of target authorization. Never ask the human to restore ZAP for `search`.
- Preserve the identity-to-profile assignment throughout the phase. Never copy cookies, storage, tokens, headers, or other session material between profiles. Compare roles or tenants through their isolated visible sessions.
- Preserve a profile whose authenticated state, challenge, or rate limit may be difficult to recover. Finish or capture that path before reuse, and use another assigned profile for independent work when available.

## Establish browser state

Call `browser_status` for the explicit profile before relying on its session or page. For numbered target profiles that the phase requires to be ZAP-routed, require `proxy.configured=true` and `proxy.mode=zap`; briefly recheck a pending proxy, but treat direct fallback or an unavailable profile as degraded readiness rather than silently continuing.

Each AgentRun owns only the tabs it creates inside the selected shared profile. A first page-scoped action creates a private tab automatically. Use `browser_tabs action=list` to inspect only your tabs, `open` to create and activate a blank tab, `select` with its `tab_id` to change the active tab, and `close` to close one of your tabs. Popups and `window.open` pages inherit your ownership. Treat a nonexistent tab ID as foreign or stale; never try to discover another AgentRun's tabs.

DOM state, snapshot refs, active page, network entries, and response IDs are local to your AgentRun controller. Cookie, local-storage, service-worker, authentication, download, and artifact state remain shared by every AgentRun using the same profile, so tab isolation is not account isolation. Use different numbered profiles for different identities. A child or fallback may close only its own tabs with `browser_tabs`; only the original phase root can use `browser_close` to close the complete selected profile.

Before a target mutation, take a fresh `browser_snapshot` and use its current actionable refs. Start with the 12k text default. Narrow long pages with a precise CSS `selector`, then continue with `next_text_offset` as `text_offset`; increase limits only when selection and pagination cannot capture the required evidence.

Use the normal visible product journey and the least surprising browser action that expresses the intended user behavior. Do not retry a cancelled or transport-interrupted mutation because its target-side effect may be unknown. Save required screenshots, downloads, network facts, and other durable evidence before handoff because every AgentRun's tabs close when that run ends.

## Handle secrets and authentication

Store every supplied secret with `variable` before browser input. Pass the exact saved identifier as `{{var:<saved-name>}}`; the host resolves it after the model boundary. Never read a saved value back, expose it in narration or artifacts, paste it into another tool call, or use browser evidence to recover it. In durable documents, use only neutral `[session-variable:<saved-name>]` identifiers, never executable templates.

Complete an explicitly supplied account's ordinary multi-step sign-in flow autonomously when stored access is sufficient. Do not copy a working session into another profile or test an identity provider as a separate target merely because the application redirects through it. Confirm authentication from the target's visible UI and record only the non-secret identity, role, tenant, and state required by the phase.

For a visible CAPTCHA or anti-bot challenge, preserve and foreground the challenged tab, use the browser CAPTCHA status and handoff tools from the same AgentRun and tab, and continue only after the host confirms resolution. The pause is scoped to that AgentRun, profile, tab, and origin; sibling AgentRuns and unrelated owned tabs remain usable. Never solve, bypass, inject a token for, or infer resolution of a human challenge. For a missing human factor, rejected or locked access, unavailable profile, or degraded proxy, use the phase-designated human question only after autonomous progress cannot continue.

## Run the Brief readiness preflight

Run this bounded preflight only for accounts explicitly assigned to numbered target profiles. In Brief, the required `engagement_policy configure` must succeed before the first numbered-profile `browser_status` or target navigation.

For each supplied numbered profile:

1. Attest availability and the required ZAP route with `browser_status`.
2. Open only the supplied normal entry point once and complete ordinary login autonomously when necessary.
3. Confirm from visible target UI that the session is authenticated and, when multiple identities were promised, that the profiles are visibly distinct.
4. Ask the human only when a human factor, rejected or locked access, unavailable profile, or degraded proxy prevents readiness. In Brief, offer the single `OK, retry` repair path and repeat only the failed readiness check; decline or cancellation leaves the profile `BLOCKED`.
5. Inspect `browser_network_log` only after the normal load to inventory passive application dependencies and retain evidence for downstream reasoning.

This is one ordinary readiness journey, not reconnaissance or a security test. Do not hand off declared access as ready unless authentication, identity distinctness, and required proxy routing are evidenced.

## Treat network observations as evidence, not authority

Use `browser_network_log` to observe requests already generated by the authorized browser journey. Record relevant origin, role, and scope status without unnecessary secret-bearing headers, bodies, query values, or cookies.

An automatically contacted API, CDN, identity service, status endpoint, payment service, or third party is a dependency observation, not an additional testing target. Never replay, mutate, enumerate, or directly test it unless supplied authorization independently covers the exact origin and action. When active ZAP work is permitted and required, load and follow the `operate-zap` skill before using `zap_*` tools or resources.
