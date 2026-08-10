---
name: operate-firefox-marionette
description: Operate a managed Firefox/Marionette laboratory for privileged chrome-context experiments, content automation, real WebDriver windows, permission readback, and synthetic X11 clipboard controls. Use when a browser-security discriminator depends on a specific Firefox executable, chrome/content context, Marionette responses, permission APIs, window lifecycle, or X11 clipboard ownership.
---

# Operate Firefox Marionette

Use this laboratory only for an authorized browser-security discriminator. Keep ordinary program-platform browsing in the normal browser tools; select `firefox_lab` when the test requires a particular Firefox build, Marionette, chrome context, privileged permission APIs, or controlled X11 state.

## Establish a baseline

Record the Firefox executable and build identity, target behavior, requested context, origin, permission state, expected signal, negative control, positive control, and teardown requirement. Launch with `firefox_lab launch`, then call `status` and retain the discovered Marionette port, profile, display, context, capabilities, process, and log path.

For permission experiments, run an unseeded B/B control first. Use `set_permission` only after the control is stable; it writes through Firefox's active privileged API and reads the value back immediately. If seeding or readback fails, stop the discriminator as inconclusive. Never edit Firefox profile databases directly.

## Exercise one discriminator

Create actual WebDriver windows with `new_window`; do not synthesize tabs with `gBrowser.addTab`. Navigate with `navigate` and use `execute` for the smallest script that answers the hypothesis. Select chrome context only when privileged browser state is essential. The managed launcher restores the prior context after each scoped operation, but verify `status` before a dependent follow-up.

For clipboard tests, use `x11_clipboard set` with synthetic UTF-8 text, inspect only `TARGETS` or ownership status, and clear the selection after the control. Never read or persist a user's real clipboard contents.

## Close and classify

Call `firefox_lab close` even after an error; close is idempotent and owns Firefox, Xvfb, profile, socket, windows, and cleanup. Preserve exact build, commands, controls, normalized response, permission readback, logs, failure point, and cleanup diagnostics. A failed control, lost Marionette socket, mismatched context, or unreadable permission is an inconclusive test, not a product finding.
