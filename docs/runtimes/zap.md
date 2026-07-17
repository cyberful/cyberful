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
proxying. Ordinary environment settings cannot grant target access: Assessment
and Remediate still require the host runtime-authorization gate, and Code Audit
and Secure Review remain offline.

Build and exercise the real integration with `make test-zap`. Cyberful cleans
up phase bridges and owned runtimes on handoff, abort, and shutdown.
