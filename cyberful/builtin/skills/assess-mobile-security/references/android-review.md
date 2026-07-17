# Android Review

## Package and Component Map

Inspect manifest merge results, exported activities, services, receivers, providers, permissions, intent filters, app links, task and launch modes, backup rules, network security configuration, debuggability, SDK levels, shared user assumptions, and dynamically registered receivers.

Effective exported state depends on component type, intent filters, target SDK, manifest merge, and OS behavior. Inspect the final packaged manifest.

## IPC and Entry Points

For each intent, binder service, provider, pending intent, broadcast, file provider, and deep link, test caller identity, permission strength, URI grants, path selection, mutable extras, replay, and confused-deputy behavior.

High-yield checks:

- mutable or implicit pending intents;
- custom permissions with weak protection level or name collision;
- providers exposing selection, projection, file, or traversal primitives;
- intent redirection into non-exported privileged components;
- task hijacking and authentication callback confusion;
- deep links that act before session or tenant binding;
- broadcast data trusted without sender verification.

## WebView and Code Loading

Map JavaScript enablement, bridges, exposed methods, origin and navigation policy, file/content access, mixed content, safe browsing, SSL error handling, popup behavior, and URL overrides. A bridge is privileged native API reachable by every origin the WebView can load.

Review dynamic dex, native library, plugin, update, and resource loading. Establish integrity and origin of code before execution.

## Runtime Hints

- Compare clean install, upgrade, restore, work profile, secondary user, and device migration.
- Background activities, notification actions, and widgets may bypass the foreground authentication gate.
- Accessibility, screenshots, recents thumbnails, autofill, and notification previews create secondary disclosure paths.
- Keystore key properties can differ by OS, hardware backing, user authentication timeout, and device enrollment changes.
- Integrity verdicts must be server-bound to nonce, app identity, account, action, and freshness.
