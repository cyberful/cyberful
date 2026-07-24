# Ghidra MCP

This context builds Cyberful's persistent headless Ghidra 12.1.2 service and
its disposable stdio bridge.

The service uses the official checksum-pinned Ghidra release and its bundled
PyGhidra package. It opens one project under `/ghidra/store`, reads import
sources from the read-only `/workspace` mount, listens only on container
loopback, and serializes every JVM operation. The bridge joins that network
namespace, authenticates with `CYBER_GHIDRA_MCP_KEY`, and forwards MCP bytes
without parsing or logging them.

The service image is pinned to `linux/amd64` because the official distribution
does not include a Linux ARM64 decompiler. It runs natively on Linux x86_64 and
Intel macOS Docker Desktop, and through Docker Desktop emulation on Apple
Silicon. Windows is not a supported target for this runtime.

Build and run the complete persistence contract from the repository root:

```sh
make test-ghidra
```

The public tools are `ghidra_project`, `ghidra_import`, `ghidra_job`,
`ghidra_search`, `ghidra_listing`, `ghidra_decompile`, `ghidra_xrefs`,
`ghidra_call_graph`, and `ghidra_annotations`. Arbitrary scripts, debugger
control, binary patching, and generic Java/Python evaluation are intentionally
absent.

See [the Ghidra runtime guide](../../docs/runtimes/ghidra.md) for lifecycle,
phase policy, persistence, hardening, and configuration.
