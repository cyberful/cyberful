# Security tools

Cyberful brings together five tool environments. You normally do not need to
start them yourself: Cyberful prepares them and gives each phase only the tools
it needs.

- [cyberful-os](cyberful-os.md) provides the isolated security-tool catalog.
- [Browser](browser.md) provides DOM, network, cookie, artifact, and controlled
  interaction tools through a dedicated Chromium or Chrome profile.
- [OWASP ZAP](zap.md) provides headless proxy and scanning capabilities for
  traffic-authorized phases.
- [Ghidra](ghidra.md) provides persistent headless reverse engineering,
  decompilation, call graphs, cross-references, and annotations.
- [EVM runtime](evm.md) provides pinned Foundry binaries, authenticated
  multi-repository materialization, and an engagement-owned Anvil lifecycle.

Pentest and Bug Bounty Program receive browser and ZAP traffic only inside their
recorded mission. Their investigation phases may use the networkless persistent
Ghidra project. Bug Bounty may also use the local EVM lab without an RPC proxy
or method filter. Code Audit receives no external target-traffic route. Its runtime lab uses a
source-blind dependency-bootstrap container followed by offline project
execution and loopback attack inside cyberful-os.

Each sequential phase receives a fresh private gateway. The host injects
ephemeral keys, loopback ports, mounts, and network policy; agents cannot turn
an environment setting into broader authorization.

Exposed tools are callable directly under gateway phase policy, the live-target
mission, traffic budgets, and the visible-CAPTCHA interlock. Individual HTTP
rejections do not globally disable independent authorized work. Actual calls are recorded in the
workarea's metadata-only `raw/operations/tool-usage.csv`; raw phase transcripts
may retain their full arguments and results according to the local retention
setting.
