# Cyberful ZAP

Cyberful runs one headless OWASP ZAP container per engagement and one short-lived bridge container for
each phase gateway. The bridge shares the ZAP container's network namespace, so the official MCP server
remains bound to loopback and is never published on the host.

The runtime image is pinned to the official ZAP 2.17.0 stable OCI digest. The MCP add-on is pinned to
0.2.0 and verified with the SHA-256 published in the ZAP add-on catalog. Runtime update checks and API
file transfer are disabled.

The same engagement root is mounted at `/zap/wrk` in both containers. Both the
official `zap_generate_report` and Cyberful's `zap_generate_scoped_report`
confine output to that mount and return `engagement_root_relative_path`. The
scoped wrapper additionally requires exact authorized HTTP(S) origins and uses
ZAP's server-side report filter; it is the default for the final client
artifact.

`zap_http_request` never guesses a destination scheme. Absolute-form requests
are accepted directly; origin-form requests require the exact `target_url` and
are normalized before sending. The bridge then checks the URL ZAP recorded.
The equivalent raw `core/action/sendRequest` operation is hidden from the
generic API catalog.

`zap_history_search` and `zap_history_get` return metadata by default. Complete
headers and bodies require `include_bodies: true`. Large or binary results are
content-addressed under `.cyberful-zap/objects/`, so repeated pages and message
reads reuse one on-disk value instead of emitting timestamp-named duplicates.
The generic API catalog omits `core/view/message` and `core/view/messages` so
callers cannot bypass the wrapper's projection and opt-in boundary.

For local development:

```sh
docker build -t cyberful-zap:2.17.0 -f Dockerfile .
docker build -t cyberful-zap-bridge:0.1.0 -f Dockerfile.bridge .
```
