# API Contract Coverage Method

Use one canonical operation key: uppercase HTTP method, one space, and the contract path template exactly as selected for comparison. Normalize gateway prefixes and aliases in the inventories before analysis; the script deliberately does not guess equivalence.

## Evidence classes

- Contract evidence comes from bounded OpenAPI JSON files and records the source file plus JSON pointer.
- Implementation evidence comes from a reviewed route inventory generated from the production composition root, not from controller files alone.
- Observation evidence comes from authorized traces, proxy logs, tests, or traffic inventories and does not prove absence when an operation was not observed.

## Security interpretation

OpenAPI root security applies unless an operation overrides it. An empty security array or an empty requirement object within its alternatives explicitly permits anonymous access. Missing root and operation security means the contract makes no authentication claim. Neither state proves the implementation behavior; inspect middleware and handler authorization.

## Drift decisions

Before filing drift, account for version prefixes, host routing, method aliases, generated `HEAD`/`OPTIONS`, deprecated versions, internal-only registrations, and asynchronous adapters. Cite source evidence for both sides and record uncertainty rather than inventing a match.
