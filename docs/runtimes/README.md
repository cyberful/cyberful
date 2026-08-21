# Security tools

Cyberful presents five capability families, but only three container environments. You normally start none of them yourself: the host gives each phase only its allowed MCP surface.

- [cyberful-os](cyberful-os.md) is the shared tooling image used by the core security/Ghidra role and the dedicated ZAP role.
- [Built-in skill catalog](skill-catalog.md) documents the 107 first-party procedures, progressive loading, active-resource contract, and framework snapshots.
- [Complete tool and MCP catalog](tool-catalog.md) lists every first-party tool surface, version policy, description, and use case.
- [Browser](browser.md) provides the pinned hardened agent-browser fork, persistent target profiles, canonical `web_search`, ZAP routing, passive human login, and first-party CAPTCHA solver.
- [OWASP ZAP](zap.md) provides headless proxy and scanning capabilities for traffic-authorized phases.
- [Ghidra](ghidra.md) provides persistent headless reverse engineering, decompilation, call graphs, cross-references, and annotations.
- [EVM runtime](evm.md) provides pinned Foundry binaries, authenticated multi-repository materialization, and an engagement-owned Anvil lifecycle.
- [CVE Dictionary](cve-dictionary.md) provides a pinned, offline, semantically searchable CVE corpus with durable hypothesis memory.
- [MITRE ATT&CK MCP](mitre-attack.md) provides the build-resolved Enterprise, Mobile, and ICS STIX snapshot as a deterministic offline reasoning lens without limiting zero-day or novel-path discovery.

Pentest and Bug Bounty Program receive browser and dedicated-ZAP traffic only inside their recorded mission. Their investigation phases may use the persistent Ghidra project in the core tooling container. Bug Bounty may also use the local EVM lab without an RPC proxy or method filter. Code Audit receives no external target-traffic route. Its runtime lab uses a source-blind dependency-bootstrap container followed by offline project execution and loopback attack inside cyberful-os.

Each sequential phase receives a fresh private gateway and reconnects through `docker exec`; the tooling container itself lives for the whole engagement. The host injects ephemeral keys, loopback ports, mounts, and fixed engagement network policy. Agents cannot turn an environment setting into broader authorization.

Exposed tools are callable directly under gateway phase policy, the live-target mission, and traffic budgets. A visible CAPTCHA is handled autonomously with browser actions or the fixed solver before a bounded human fallback. Individual HTTP rejections do not globally disable independent authorized work. Actual calls are recorded in the workarea's metadata-only `raw/operations/tool-usage.csv`; raw phase transcripts may retain their full arguments and results according to the local retention setting.
