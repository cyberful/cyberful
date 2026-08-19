# Desktop client audit

Use this reference to reconcile code, package, installation, and runtime boundaries in a desktop application.

## Bind package to execution

Record package hash and signature, installation scope, executable and helper paths, permissions, service registrations, update endpoint and signing chain, rollback policy, launch arguments, environment, and effective user. Confirm which configuration and resources the installed build actually loads.

## Treat every local bridge as a protocol

For IPC, custom URLs, deep links, local HTTP, named pipes, Unix sockets, COM/XPC/D-Bus, preload APIs, native messaging, and privileged helpers, record endpoint discovery, peer identity, message framing, canonicalization, authorization, replay, response confidentiality, and effects. Local reachability is not proof of same-user or same-profile intent.

## Separate renderer and native authority

For WebViews and Electron-style applications, map navigation, origin, CSP, sandbox, context isolation, node integration, preload exposure, message validation, download and file handling, external URL launch, and update/UI trust. Follow attacker-controlled renderer values through every native bridge to filesystem, process, credential, and network effects.
