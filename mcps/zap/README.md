# Cyberful ZAP

These sources are copied into the unified cyberful-os image. Cyberful runs one
tooling container per engagement and one short-lived `docker exec` bridge
process per eligible phase gateway. The ZAP service and bridge communicate on
container loopback; only ZAP port 8080 may be published on host loopback.

The runtime image is pinned to the official ZAP 2.17.0 stable OCI digest. The MCP add-on is pinned to
0.2.0 and verified with the SHA-256 published in the ZAP add-on catalog. Runtime
update checks remain disabled to prevent background traffic. API file transfer
and MCP history recording remain available inside the isolated runtime.

The bridge exposes the complete API catalog reported by ZAP. It does not derive
an origin allowlist from the prompt, filter lifecycle or security operations,
disable redirects, or apply another authorization policy to official MCP tools.
The active mission and agent instructions own engagement scope.

The same engagement root is mounted at `/zap/wrk` in both containers. Both the
official `zap_generate_report` and Cyberful's
`zap_generate_workarea_report` confine output to that mount and return
`engagement_root_relative_path`. The workarea wrapper includes the complete ZAP
session and applies no site filter.

`zap_http_request` never guesses a destination scheme. Absolute-form requests
are accepted directly; origin-form requests require the exact `target_url` and
are normalized before sending. The result reports both the requested and
recorded URL. The equivalent raw `core/action/sendRequest` operation also
remains available through the generic API catalog.

`zap_history_search` and `zap_history_get` return metadata by default. Complete
headers and bodies require `include_bodies: true`. Large or binary results are
content-addressed under `.cyberful-zap/objects/`, so repeated pages and message
reads reuse one on-disk value instead of emitting timestamp-named duplicates.
The generic `core/view/message` and `core/view/messages` operations remain
available when an agent needs the native ZAP response.

For local development, build and test the unified image from the repository
root:

```sh
make runtime-build
make test-zap
```
