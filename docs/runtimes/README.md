# Security tools

Cyberful brings together three tool environments. You normally do not need to
start them yourself: Cyberful prepares them and gives each phase only the tools
it needs.

- [cyberful-os](cyberful-os.md) provides the isolated security-tool catalog.
- [Browser](browser.md) provides DOM, network, cookie, artifact, and controlled
  interaction tools through a dedicated Chromium or Chrome profile.
- [OWASP ZAP](zap.md) provides headless proxy and scanning capabilities for
  traffic-authorized phases.
- [Local fallback inference](fallback-inference.md) optionally connects an
  operator-owned loopback Responses server for bounded assist and policy-block
  recovery while Codex remains the primary subsystem.

Pentest receives browser and ZAP traffic only inside its recorded mission. Code
Audit receives no external target-traffic route. Its runtime lab uses a
source-blind dependency-bootstrap container followed by offline project
execution and loopback attack inside cyberful-os.

Each sequential phase receives a fresh private gateway. The host injects
ephemeral keys, loopback ports, mounts, and network policy; agents cannot turn
an environment setting into broader authorization.

Exposed tools are callable directly under gateway phase policy, the Pentest
mission, traffic budgets, and the visible-CAPTCHA interlock. Individual HTTP
rejections do not globally disable independent authorized work. Actual calls are recorded in the
workarea's metadata-only `raw/operations/tool-usage.csv`; raw phase transcripts
may retain their full arguments and results according to the local retention
setting.
