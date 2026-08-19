---
name: audit-embedded-firmware-security
description: Audit extracted embedded firmware for boot and update trust, credential and secret handling, service exposure, privilege boundaries, parsers, persistence, cryptography, hardening, recovery, and product-specific security invariants. Use for static firmware evidence after safe acquisition and extraction.
metadata:
  domain: application-security
  subdomain: firmware-security-audit
  triggers:
    - audit embedded firmware security
    - firmware code and configuration audit
    - secure boot update review
    - embedded service exposure audit
    - firmware secret and credential review
  tags:
    - firmware
    - embedded
    - secure-boot
    - updates
    - root-filesystem
    - device-security
  frameworks:
    nist_csf:
      - PR.PS
      - GV.SC
---

# Audit Embedded Firmware Security

Audit the extracted artifact as evidence tied to a device, version, acquisition path, and extraction manifest. Do not execute an extracted init system or treat strings and filenames as proof of reachable behavior.

## Establish artifact and trust provenance

Record image hash, product and hardware claims, partitions, filesystems, architecture, boot artifacts, signing and verification metadata, update format, rollback controls, recovery images, build identifiers, packages, native hardening, and extraction limitations.

Copy [assets/firmware-trust-ledger.template.json](assets/firmware-trust-ledger.template.json) into the workarea. Read [references/firmware-audit-method.md](references/firmware-audit-method.md) before connecting an extracted component to boot, update, service, or persistence behavior.

## Trace reachable security boundaries

Map startup and privilege transitions, users and groups, service listeners, IPC, parsers, web routes, update and provisioning code, credentials, keys, certificates, debug paths, logging, storage, firewall rules, kernel and module configuration, and recovery behavior. Trace candidates into code and configuration rather than reporting inventory alone.

Use `operate-firmware-laboratory` for import, extraction, comparison, emulation, and managed tool operation. Route whole-product and lifecycle risk to `assess-embedded-iot-security`; this skill owns static firmware audit reasoning.

## Deliver

Tie every candidate to artifact hashes, paths, startup or call reachability, attacker position, privilege or identity, device state, fleet reuse, control comparison, and a bounded validation plan. Mark extraction ambiguity and version-to-device uncertainty explicitly.
