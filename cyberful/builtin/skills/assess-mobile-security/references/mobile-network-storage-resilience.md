# Mobile Network, Storage, and Resilience

## Network

Capture normal traffic, alternate API hosts, WebSockets, background sync, analytics, crash reporting, feature flags, update checks, certificate enrollment, and third-party SDK endpoints. Compare proxy-visible traffic with device network observations to find pinning or alternate stacks.

Review hostname verification, trust managers, certificate pin lifecycle, cleartext exceptions, redirect behavior, client certificates, proxy handling, DNS, and request signing. Pinning needs a rotation and recovery design; it does not repair application authorization.

## Data and Credential Lifecycle

Trace tokens, refresh artifacts, device keys, PII, files, database rows, thumbnails, caches, logs, notifications, clipboard, screenshots, memory, backups, cloud sync, and shared containers. Exercise logout, account switch, tenant switch, reinstall, restore, upgrade, device lock, and remote revocation.

## Authentication and Device Binding

Map enrollment, attestation, key generation, biometric gate, token issuance, refresh, recovery, new-device approval, push challenge, and device removal. Bind challenges to account, device key, transaction, nonce, audience, and freshness.

## Resilience Review

Test whether modified clients can:

- bypass local feature or role gates;
- change API environment or certificate trust;
- extract reusable secrets;
- alter transaction fields after UI confirmation;
- disable telemetry or integrity checks;
- invoke hidden or debug functionality;
- replay attestation or device-binding artifacts.

Use the result to identify server assumptions that rely on an untampered client.

## Competitive Hints

- Compare foreground, background, extension, and push-triggered code paths; they often use different credential stores and trust evaluators.
- Remote configuration can reactivate dormant endpoints or debug features absent from static navigation.
- SDKs may transmit identifiers before consent or logout cleanup even when first-party storage is correct.
- Offline queues can replay operations after logout or tenant change under a refreshed identity.
- UI transaction confirmation can display one canonicalization while the API signs another.
- Device binding can collapse when recovery issues a new token without invalidating the old device key.
- API anti-automation relying on app signatures or attestation should still be tested for replay, relay, nonce reuse, and weak server binding.
