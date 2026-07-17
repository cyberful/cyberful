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

Scanner and other material active capabilities require a phase-local
`tool_decision`. Live tools accept `USE`, `SKIP`, or `BLOCKED`; an absent name
is accepted only as `BLOCKED` when it exactly matches Cyberful's fixed gated
tool catalog. The resulting usage row records `capability_status=missing` and
cannot authorize execution. Unknown, foreign-qualified, and client-qualified
unavailable names remain rejected. The decision result shows both the stable
`reason_code` and the human `rationale`. A decision for a live non-gated tool is
coverage metadata only and the result says explicitly that it does not grant or
block execution.
