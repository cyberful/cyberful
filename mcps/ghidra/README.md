# Ghidra MCP

These sources are copied into Cyberful's unified multi-architecture image as a persistent headless Ghidra service and an in-container stdio bridge.

Kali supplies Ghidra `12.1.2+ds-0kali1`, its architecture-native decompiler, and bundled PyGhidra wheels for both `linux/amd64` and `linux/arm64`. The service opens one project under `/ghidra/store`, reads imports from the writable engagement `/workspace`, listens only on container loopback, and serializes JVM operations. The bridge is started with `docker exec`, authenticates with `CYBER_GHIDRA_MCP_KEY`, and forwards MCP bytes without logging them.

Build the unified image and run the persistence contract from the repository root:

```sh
make runtime-build
make test-ghidra
```

The public tools are `ghidra_project`, `ghidra_import`, `ghidra_job`, `ghidra_search`, `ghidra_listing`, `ghidra_decompile`, `ghidra_xrefs`, `ghidra_call_graph`, and `ghidra_annotations`. Arbitrary scripts, debugger control, binary patching, and generic Java/Python evaluation are intentionally absent.

See [the Ghidra runtime guide](../../docs/runtimes/ghidra.md) for lifecycle, phase policy, persistence, hardening, and configuration.
