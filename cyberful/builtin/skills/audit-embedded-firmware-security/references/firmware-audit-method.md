# Firmware audit method

Use this reference after safe extraction has produced hashes and a filesystem or component manifest.

## Prove startup and exposure

Connect a binary or script to unit files, init scripts, supervisors, socket activation, containers, cron, hotplug, web dispatch, IPC registration, or update hooks. Establish effective user, capabilities, namespaces, filesystem permissions, arguments, environment, listener address, protocol, and authentication before rating exposure.

## Reconstruct trust chains

For boot and updates, trace root keys, signature coverage, parser order, version and rollback state, board or product binding, encryption versus authenticity, recovery behavior, and failure handling. Identify which metadata is authenticated and which fields influence parsing or placement before verification.

## Scale device evidence carefully

Separate per-image constants from per-device secrets, factory material, enrollment output, and runtime-generated state. A credential found in one image becomes fleet risk only when generation, reuse, or backend acceptance supports that conclusion.
