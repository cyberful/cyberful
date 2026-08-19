---
name: audit-desktop-client-security
description: Audit desktop client source, binaries, packaging, updater, local storage, IPC, protocol handlers, WebViews, plugins, native bridges, credential use, and OS integration for trust-boundary failures. Use for Windows, macOS, or Linux application code and artifact review.
metadata:
  domain: application-security
  subdomain: desktop-client-security
  triggers:
    - audit desktop client security
    - Electron application security audit
    - desktop updater security review
    - native client IPC audit
    - desktop credential storage review
  tags:
    - desktop
    - Electron
    - IPC
    - updater
    - protocol-handlers
    - native-bridge
  frameworks:
    nist_csf:
      - PR.PS
      - PR.AA
---

# Audit Desktop Client Security

Audit the installed client as an OS-integrated trust graph. A server-side permission does not protect local IPC, update, file, protocol, plugin, WebView, credential, or privileged-helper boundaries.

## Map entry and privilege boundaries

Inventory executables, packages, signatures, update channels, services and helpers, IPC endpoints, custom protocols, file associations, deep links, drag-and-drop and clipboard inputs, local databases, credential stores, browser or WebView contexts, preload and native bridges, plugins, dynamic loading, and command execution paths.

Copy [assets/desktop-boundary-matrix.template.json](assets/desktop-boundary-matrix.template.json) into the workarea. Read [references/desktop-client-audit.md](references/desktop-client-audit.md) when reconciling source assumptions with installed or packaged behavior.

## Trace untrusted data to effects

Follow origins, files, URLs, messages, update metadata, local users, and remote content through parsing, canonicalization, authorization, process boundaries, privilege changes, filesystem writes, credential access, and native calls. Test mentally for cross-user, cross-origin, cross-profile, and downgrade or rollback confusion.

Route binary reversing to `operate-binary-analysis-toolchain`, browser-specific behavior to browser specialists, and memory-unsafe native code to `audit-native-memory-safety`. Keep this audit focused on desktop composition and OS integration.

## Deliver

Report the producer, consumer, canonical form, identity, authorization owner, resulting OS or application effect, deployment prerequisites, source or artifact evidence, and narrowest safe validation. Separate local self-impact from cross-user, privilege, persistence, or remote impact.
