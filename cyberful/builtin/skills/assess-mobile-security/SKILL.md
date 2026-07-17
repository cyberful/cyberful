---
name: assess-mobile-security
description: Assess Android and iOS applications through coordinated static, dynamic, backend, platform, and resilience analysis. Use for mobile app security assessments covering storage, cryptography, authentication, network communication, deep links, IPC, WebViews, platform permissions, biometrics, code loading, update integrity, reverse engineering, tampering, device compromise assumptions, and MASVS or MASTG-aligned coverage.
---

# Assess Mobile Security

## Establish the Mobile Trust Model

Define app identifiers, signing identities, distribution channel, minimum and target OS, device integrity assumptions, user roles, backend environments, third-party SDKs, deep-link domains, extensions, companion apps, and sensitive capabilities.

Keep client and backend boundaries separate. A mobile control can raise extraction or tampering cost, but server authorization must remain correct when the client is modified.

Use MASVS and MASTG as coverage indexes, then adapt tests to the application's actual architecture. Read [android-review.md](references/android-review.md), [ios-review.md](references/ios-review.md), and [mobile-network-storage-resilience.md](references/mobile-network-storage-resilience.md) as applicable.

## Correlate Static and Dynamic Evidence

1. Inventory packages, components, entitlements, permissions, URL handlers, SDKs, native libraries, and build configuration.
2. Trace sensitive data and credentials through storage, logs, IPC, memory, network, backups, notifications, and screenshots.
3. Exercise authentication, enrollment, device binding, recovery, offline state, and account switching.
4. Observe actual runtime behavior under normal, instrumented, proxied, background, locked, restored, and upgraded states.
5. Replay the same API paths outside the app to validate server-side controls.

Static declarations and runtime behavior routinely diverge because of feature flags, remote config, SDK initialization, OS version, and build flavor.

## Test Platform Boundaries

Review exported components, deep and universal links, pasteboard or clipboard, file providers, content providers, app extensions, intents, custom URL schemes, WebViews, JavaScript bridges, local servers, push notifications, widgets, and cross-app authentication brokers.

For each entry point, determine who can invoke it, which identity it uses, what inputs select resources or actions, and whether invocation works while locked, logged out, or in another tenant.

## Evaluate Resilience Against the Threat Model

Review signing, update channel, anti-tamper, root or jailbreak detection, debugger and instrumentation resistance, integrity APIs, obfuscation, and secret extraction only against explicitly required resilience goals. Treat bypass resistance as layered cost, not as a server-side access control.

## Report End-to-End Impact

Document build and OS, device state, static location, runtime sequence, backend request, platform boundary, data or action obtained, and whether the condition survives a modified client. Map findings to the applicable MASVS control family without letting the taxonomy replace evidence.
