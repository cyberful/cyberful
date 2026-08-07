# Dependency Patch Registry

This directory contains repository-owned patches that Bun applies to installed dependencies through the root `package.json` `patchedDependencies` field. Patch files are production inputs: keep them versioned, review them as source changes, and update this registry whenever a patch is added, changed, superseded, or removed.

## Registry

| ID          | Dependency                     | Status | Purpose                                                               | Regression coverage                          |
| ----------- | ------------------------------ | ------ | --------------------------------------------------------------------- | -------------------------------------------- |
| `PI-AI-001` | `@earendil-works/pi-ai@0.81.1` | Active | Preserve structured Codex cyber-policy failures across the Pi adapter | `cyberful/src/subsystem/pi-security.test.ts` |

## PI-AI-001: Preserve Structured Codex Cyber-Policy Failures

### Record

- **Artifact:** [`@earendil-works%2Fpi-ai@0.81.1.patch`](./@earendil-works%2Fpi-ai@0.81.1.patch)
- **Registration:** [`package.json`](../package.json) and [`bun.lock`](../bun.lock)
- **Patched upstream file:** `dist/api/openai-codex-responses.js`
- **Consumer:** [`cyberful/src/subsystem/pi-security.ts`](../cyberful/src/subsystem/pi-security.ts)
- **Introduced by:** `2c176af` (`Adopt Pi Agent runtime and harden Cyberful execution (#21)`)
- **Removal condition:** a pinned Pi release preserves the same structured error signal for HTTP/SSE and WebSocket responses and passes the regression tests without this patch.

### Rationale

The unpatched adapter reduces some Codex failures to a message string. That discards the structured `codexErrorInfo.cyberPolicy` marker Cyberful needs to classify a provider security-policy block separately from a transport or generic provider failure. Losing that distinction can send phase execution down the wrong failure-handling path.

### Behavioral Delta

The patch:

1. preserves the provider error code parsed from non-successful HTTP responses;
2. detects the presence of `codexErrorInfo.cyberPolicy` in HTTP/SSE errors, WebSocket `error` events, and WebSocket `response.failed` events;
3. attaches the normalized marker to an assistant-message `provider_request_failure` diagnostic; and
4. deliberately reduces the marker to `{ cyberPolicy: {} }`, so internal provider decision details do not propagate into Cyberful.

It does not change request construction, authentication, retry policy, or the classification rules owned by Cyberful.

### Verification

Run the focused regression suite from the repository root:

```sh
bun run --cwd cyberful test src/subsystem/pi-security.test.ts
```

The suite verifies the pinned adapter boundary for HTTP/SSE and both supported WebSocket terminal failure events. It also verifies that nested provider details are not retained.

## Maintenance Procedure

When adding or revising a dependency patch:

1. assign a stable registry ID and document the exact dependency version, upstream file, consumer, rationale, behavioral delta, and removal condition;
2. generate or refresh the artifact with Bun's patch workflow rather than editing installed dependency state as an unrecorded local change;
3. keep the patch path aligned across `package.json`, `bun.lock`, and this registry;
4. add focused regression coverage for the behavior crossing the dependency boundary; and
5. verify the focused tests and the normal repository typecheck before merging.

On a dependency upgrade, first check whether upstream now provides the required behavior. Remove the patch when the regression suite passes against the pinned release without it; otherwise regenerate the patch for the new exact version and update its record here in the same change.
