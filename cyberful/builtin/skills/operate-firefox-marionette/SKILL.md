---
name: operate-firefox-marionette
description: Operate a managed Firefox/Marionette laboratory for privileged chrome-context experiments, content automation, real WebDriver windows, permission readback, and synthetic X11 clipboard controls. Use when a browser-security discriminator depends on a specific Firefox executable, chrome/content context, Marionette responses, permission APIs, window lifecycle, or X11 clipboard ownership.
---

# Operate Firefox Marionette

Use `firefox_lab` only for authorized browser-security tests requiring an exact Firefox build, Marionette/BiDi, chrome context, privileged permissions, or controlled X11. Use normal browser tools for program-platform browsing.

## Establish a baseline

Record the executable/hash, target behavior, context, origin, permission, expected signal, controls, and teardown. Launch with `expected_build_sha256` when known, call `status`, and retain its port, profile, display, capabilities, complete `web_socket_url`, process identity, and log. Consume the advertised BiDi URL verbatim; never derive an endpoint from its port.

For permissions, run an unseeded control first. `set_permission` uses Firefox's privileged API and immediate readback. A failed seed/readback is inconclusive. Never edit profile databases.

## Exercise one discriminator

Use `new_window`, not synthetic `gBrowser.addTab` tabs. Create and record every race context before perturbing a content process. Use `navigate` and the smallest decisive `execute` script; request chrome only when essential. Check `status` before dependent work. For BiDi, create all Marionette prerequisites, call `handoff_bidi`, use its URL, and correlate responses by command ID. Marionette is unavailable after handoff.

For clipboard tests, set synthetic UTF-8, inspect only `TARGETS`/ownership, then clear it. Never read or retain real clipboard contents.

## Close and classify

Always call idempotent `close`, including after BiDi handoff; it owns Firefox, Xvfb, profile, transports, windows, and cleanup. Use `status` process identity, never command-text PID matching (`ps|awk`, `pgrep -f`, `pkill -f`). Preserve build, controls, results, logs, failure point, and cleanup. Failed controls, transport/context loss, incomplete non-controls, or unreadable permissions are inconclusive harness results, not findings.
