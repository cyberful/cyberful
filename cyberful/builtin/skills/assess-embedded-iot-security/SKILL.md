---
name: assess-embedded-iot-security
description: Assess embedded and IoT product security across hardware roots, boot and update chains, firmware, local interfaces, radio and network protocols, companion applications, cloud services, fleet operations, and physical lifecycle. Use for broad product risk and attack-surface reviews.
metadata:
  domain: application-security
  subdomain: embedded-iot-assessment
  triggers:
    - assess embedded IoT security
    - connected device threat assessment
    - hardware firmware cloud review
    - IoT product security posture
    - device lifecycle security assessment
  tags:
    - embedded
    - IoT
    - hardware
    - firmware
    - device-cloud
    - product-security
  frameworks:
    nist_csf:
      - ID.RA
      - GV.SC
---

# Assess Embedded and IoT Security

Assess the product ecosystem, not only a firmware image. Device identity, manufacturing, physical access, radios, companion clients, cloud tenancy, update infrastructure, fleet operations, and end-of-life behavior can each dominate the risk.

## Establish lifecycle and trust zones

Map silicon and hardware roots, boot stages, debug and recovery interfaces, persistent storage, firmware components, local buses, wired and wireless protocols, mobile or desktop companions, backend services, provisioning, manufacturing, support, resale, reset, decommissioning, and update paths.

Copy [assets/device-attack-surface.template.json](assets/device-attack-surface.template.json) into the workarea. Read [references/device-system-assessment.md](references/device-system-assessment.md) when deciding which lifecycle state or trust zone owns a hypothesis.

## Prioritize cross-boundary failures

Trace device identity, secrets, authorization, tenant and owner binding, commands, telemetry, safety-relevant actions, update trust, rollback, recovery, and data deletion across zones. Include physical attacker capability explicitly and distinguish per-device compromise from fleet-wide leverage.

Route extracted-image review to `audit-embedded-firmware-security` and laboratory operation to `operate-firmware-laboratory`. Use protocol, mobile, cloud, identity, or hardware specialists for their respective evidence; do not reproduce their procedures here.

## Deliver

Produce an attack-surface matrix and prioritized risks with lifecycle state, attacker position, required access, affected population, safety or privacy consequence, evidence, uncertainty, control owner, and validation route.
