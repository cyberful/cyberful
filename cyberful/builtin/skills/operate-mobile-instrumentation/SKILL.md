---
name: operate-mobile-instrumentation
description: Operate Frida, Objection, JADX, Apktool, Android tooling, and native inspection for advanced authorized mobile application assessment. Use for spawn-time or attach-time instrumentation, Java/Kotlin and Objective-C/Swift/native boundary tracing, storage and transport observation, runtime control validation, anti-instrumentation diagnosis, multi-dex or class-loader problems, and converting static hypotheses into reproducible runtime evidence.
---

# Operate Mobile Instrumentation

Instrument to answer a narrow question: which code path ran, with which identity and data, before and after which control. A generic bypass script can hide the actual security boundary and create misleading results.

## Establish the runtime tuple

Record application hash/version/build flavor, package or bundle identifier, ABI, OS/device version, rooted/jailbroken/emulated state, Frida client/server/gadget versions, Objection version, process name/PID, spawn versus attach mode, class loader or image/module, and proxy/VPN/network path.

Keep modified packages, resigning, embedded gadgets, and externally attached instrumentation as separate test configurations.

## Move from static map to runtime hooks

Use JADX/Apktool and native analysis to locate exported surfaces, deep links, IPC, WebViews, cryptographic and storage wrappers, network clients, trust managers, native libraries, dynamic loaders, and security-control call sites. Derive hook targets from call relationships and runtime class/module enumeration rather than copied package names.

Read [references/mobile-instrumentation-fieldbook.md](references/mobile-instrumentation-fieldbook.md) before diagnosing missing hooks or anti-instrumentation behavior.

## Hook with provenance

For every hook, capture overload/signature, thread, receiver/class-loader or module offset, arguments before mutation, return/exception, arguments after mutation, and a bounded stack trace. Start observational. Mutate only the smallest value needed to test a control, then repeat without mutation.

Trace across boundaries: Java/Kotlin to JNI, Objective-C/Swift to C/C++, framework wrapper to native trust stack, encrypted storage wrapper to key provider, and WebView JavaScript bridge to privileged native code.

## Separate transport from authorization

Certificate-pinning bypass demonstrates observability of traffic, not an application vulnerability. Preserve the original failure, identify the enforcing layer, and evaluate whether sensitive operations still enforce server-side authentication, authorization, replay, and transaction integrity.

Use Objection for rapid reconnaissance and hypothesis generation. Convert important results into explicit Frida scripts or reproducible direct commands so the evidence is reviewable and version-stable.

## Diagnose failed instrumentation

Check spawn timing, child processes, split APK/dynamic features, secondary class loaders, inlining/optimization, overload mismatch, stripped symbols, Thumb/PAC offsets, module rebasing, anti-debugging, integrity checks, Frida protocol mismatch, and application restart loops. A hook that never fires says nothing about control presence.

## Deliver

Preserve exact artifact hashes, environment tuple, scripts, logs, hook provenance, static-to-dynamic mapping, original and instrumented behavior, crash/restart evidence, and limitations. Report whether the result is a client-control bypass, data exposure, server-side consequence, or instrumentation-only observation.
