# Device system assessment

Use this reference to keep a connected-device assessment complete without collapsing every layer into firmware.

## Lifecycle states

Consider manufacture, factory enrollment, distribution, first ownership, normal operation, offline operation, transfer, reset, recovery, update failure, support access, decommissioning, and disposal. Record which identities and secrets exist in each state and whether transitions erase or preserve them.

## Attacker positions

Separate remote unauthenticated, remote authenticated, adjacent radio or network, malicious owner, temporary physical access, persistent physical access, supply-chain, service technician, compromised companion, compromised cloud tenant, and privileged operator. Do not generalize evidence obtained under one position to another.

## Fleet leverage

Prioritize shared signing keys, deterministic credentials, global debug paths, update and provisioning services, common radio keys, support backdoors, and cloud authorization gaps that turn one-device knowledge into multi-device impact. Record safety, availability, privacy, and regulatory consequences separately.
