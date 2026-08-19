---
name: operate-firmware-laboratory
description: Safely extract, inventory, compare, fingerprint, and inspect Linux appliance firmware with managed firmware and user-mode native labs.
metadata:
  domain: platform-security
  subdomain: firmware-tooling
  triggers:
    - firmware laboratory
    - extract firmware image
    - emulate firmware service
    - inspect root filesystem
    - QEMU user emulation
    - firmware runtime tracing
  tags:
    - firmware
    - embedded
    - QEMU
    - binfmt
    - filesystem-analysis
  frameworks:
    nist_csf:
      - ID.AM
      - ID.RA
---

# Operate Firmware Laboratory

Treat firmware as hostile evidence. Work only on copies inside the engagement workarea, never execute an extracted init system, and never register binfmt handlers or start a full-system emulator.

## Establish identity

Record source, acquisition time, product/model claims, size, SHA-256, file identification, signature or update metadata, architecture, endianness, compression, partition and filesystem candidates. Use `firmware_lab import`, `identify`, and `manifest`; keep every returned evidence path.

## Extract deterministically

Use `firmware_lab unpack` first. For ZIP-based packages and Mozilla-style optimized archives, use `archive_extract inspect` and `extract`; it retries prepended-byte or Info-ZIP status-2 inputs through native `7zz` in a fresh destination before atomic publication. Confirm every fallback extraction result rather than assuming a successful exit means a coherent root filesystem. Use `unblob`, `binwalk`, `unsquashfs`, `ubireader_extract_files`, `dumpimage`, and `dtc` for targeted validation. Do not follow evidence symlinks outside the lab.

## Map attack surface

Use `find_services` and `find_routes`, then inspect init scripts, inetd/systemd configuration, web roots, CGI handlers, RPC schemas, default credentials, update verification, privileged helpers, writable paths, exposed sockets, debug hooks, native binaries, and version markers. Correlate observed assets with `appliance_fingerprint`; label inferred versions and confidence explicitly.

## Emulate only userspace

Create a `native_lab`, copy the smallest required executable and fixtures, and invoke `qemu_arm` or `qemu_aarch64` explicitly with the extracted rootfs. Bind listeners only inside the lab, use synthetic data, capture logs, snapshot before mutation, and stop every process. Unsupported kernels, drivers, hardware, bootloaders, and peripherals are documented limits, not approximated with an unsafe full-system setup.

## Compare and hand off

For two releases, use `firmware_lab diff` and `binary_diff` to separate packaging noise from changed services, validation, constants, calls, and security invariants. Create a `checkpoint` before handoff. Preserve hashes, extraction manifest, commands, service/route inventory, emulator limitations, changed invariants, evidence paths, and remaining hypotheses.
