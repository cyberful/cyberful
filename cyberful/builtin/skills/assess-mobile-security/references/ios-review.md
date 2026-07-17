# iOS and iPadOS Review

## Package and Entitlements

Inspect bundle identifiers, signing, provisioning, entitlements, associated domains, keychain access groups, application groups, extensions, URL schemes, document types, background modes, ATS exceptions, privacy manifests, and embedded frameworks.

Entitlements define powerful trust relationships. Cross-app keychain and app-group sharing must match intended team and bundle boundaries.

## Entry Points and Shared Data

Review universal links, custom schemes, scene and app delegates, extensions, share sheets, document providers, pasteboard, notifications, widgets, shortcuts, authentication sessions, and local network listeners.

Test canonical URL parsing, caller ambiguity for custom schemes, session and tenant binding, replay, locked-device behavior, and stale callback delivery.

## Web and Native Bridges

Map WKWebView navigation, content worlds, message handlers, injected scripts, file access, custom schemes, authentication challenges, and external navigation. Validate message origin and frame, not just handler name.

## Storage and Keychain

Review file protection class, keychain accessibility, synchronizable items, access groups, biometric access-control flags, backup inclusion, caches, databases, logs, snapshots, and extension containers.

Biometric success typically releases a locally protected credential; the server must still validate current account and device state.

## Advanced Hints

- Universal-link fallback can route the same security flow through a less trusted custom scheme.
- App extensions can access shared containers with different lifecycle and UI authentication.
- Keychain items may survive reinstall, creating stale account or device binding.
- Pasteboard behavior and disclosure vary by OS and local-only or expiration options.
- Snapshot restoration and device transfer can preserve tokens beyond intended revocation assumptions.
- Certificate trust callbacks that accept one error path can bypass otherwise strict ATS settings.
