# OWASP ZAP

Cyberful uses a headless OWASP ZAP 2.17.0 runtime and a separate stdio bridge
image. Startup prepares both images; traffic-capable engagements then receive
an isolated runtime with disposable phase gateways.

The browser is proxied through ZAP by default. Trust is scoped to the runtime's
CA public-key pin, while bridge and API keys live in owner-only temporary host
files rather than model arguments or environment output.

```dotenv
CYBER_ZAP_ENABLED=1
CYBER_BROWSER_THROUGH_ZAP=1
```

Set `CYBER_ZAP_ENABLED=0` to disable ZAP or
`CYBER_BROWSER_THROUGH_ZAP=0` to keep scanning available without browser
proxying. Ordinary environment settings cannot grant target access: Pentest is
bounded by `MISSION.md`, while Code Audit remains offline and never starts ZAP.

Build and exercise the real integration with `make test-zap`. Cyberful cleans
up phase bridges and owned runtimes on handoff, abort, and shutdown.

## OAST adapter

Call `zap_oast` without an operation to read the capability contract derived
from the installed add-on's live API catalog. Supported calls are exposed under
the single `oast` component and successful calls return an explicit
`completed` result with `data` or `empty` state.

The packaged add-on's HTTP API provides service discovery and configuration;
it does not provide registration, payload generation, polling, or interaction
history. Cyberful rejects guessed `interactsh`, `boast`, and `callback`
subcomponents before transport. A justified callback test therefore uses a
separate engagement-owned one-shot harness with a successful self-test,
bounded polling, redacted evidence, and cleanup.

An HTTP `403`, `429`, or managed challenge applies to the current request or
scan and is not a phase-wide stop. Do not retry or disguise the rejected
experiment. Continue independent authorized work only while the target is
stable; explicit mission stop conditions, scope uncertainty, systemic
instability, unexpected private data, and unplanned side effects still stop
target traffic.
