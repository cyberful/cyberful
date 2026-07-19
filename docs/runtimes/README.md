# Security tools

Cyberful brings together three tool environments. You normally do not need to
start them yourself: Cyberful prepares them and gives each phase only the tools
it needs.

- [cyberful-os](cyberful-os.md) provides the isolated security-tool catalog.
- [Browser](browser.md) provides DOM, network, cookie, artifact, and controlled
  interaction tools through a dedicated Chromium or Chrome profile.
- [OWASP ZAP](zap.md) provides headless proxy and scanning capabilities for
  traffic-authorized phases.

Code Audit and Secure Review do not receive a target-traffic route. Assessment
and Remediate require a host-owned runtime authorization for the exact origins
and call budget before eligible phases can use browser or ZAP traffic.

Each sequential phase receives a fresh private gateway. The host injects
ephemeral keys, loopback ports, mounts, and network policy; agents cannot turn
an environment setting into broader authorization.

Exposed tools are callable directly under gateway phase policy, runtime scope
authorization, traffic budgets, and the visible-CAPTCHA interlock. Individual HTTP
rejections do not globally disable independent authorized work. Actual calls are recorded in the
workarea's metadata-only `raw/operations/tool-usage.csv`; raw phase transcripts
may retain their full arguments and results according to the local retention
setting.
