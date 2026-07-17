# Mobile Instrumentation Fieldbook

## Hook-placement hierarchy

1. Observe the application abstraction that expresses intent.
2. Observe the platform API or native boundary that performs the effect.
3. Correlate identifiers, thread, timing, and stack across both.
4. Mutate at only one layer and compare.

This prevents a bypass at a generic framework function from being mistaken for a flaw in application policy.

## Android weak signals

- class exists statically but not in the default loader: enumerate loaders and split/dynamic-feature installation;
- network library symbols exist but hooks do not fire: native Cronet/QUIC, WebView, vendor SDK, or another process may own traffic;
- exported component appears permission-protected: test signature level, permission definition ownership, aliases, task behavior, and indirect PendingIntent paths;
- keystore key is non-exportable: hook plaintext immediately before cryptographic use and authorization immediately before key access;
- root detection bypass changes API behavior: determine whether device posture is trusted server-side or only client-side.

## iOS weak signals

- Swift symbol absent: inspect Objective-C exposure, metadata, stripped exports, protocol witnesses, and native call sites;
- pinning bypass at NSURLSession has no effect: inspect Network.framework, custom BoringSSL, WKWebView, or native SDK stacks;
- Keychain item appears protected: evaluate accessibility class, access group, synchronizable flag, biometric reuse duration, and data exposure after device-state transitions;
- URL scheme or universal link validates the host: also test path canonicalization, encoded separators, duplicate query keys, and post-login continuation state.

## Anti-instrumentation diagnostics

Differentiate protocol mismatch, crash from bad hook ABI, watchdog timeout, integrity verification, debugger checks, loaded-module/name scans, filesystem probes, port scans, timing checks, and server-side device attestation. Preserve the earliest divergent event.

## False-negative traps

Spawn-only initialization, child services, app extensions, isolated Android processes, secondary class loaders, native libraries loaded after startup, overloaded/generic bridge methods, compiler inlining, stripped symbols, pointer authentication, certificate pinning in native code, QUIC traffic, and cached authenticated state.

## Evidence pattern

Show a stable before/after pair with one controlled mutation, the exact hook site, stack provenance, and the downstream security effect. Screenshots without hook and request correlation are weak evidence.
