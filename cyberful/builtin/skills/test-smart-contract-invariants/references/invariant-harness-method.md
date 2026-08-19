# Invariant harness method

Use this reference when translating a contract hypothesis into Foundry fuzz, invariant, or regression evidence.

## State the property before the harness

Write the property in domain terms and define its unit, scope, and exceptions. Useful forms include conservation, monotonicity, authorization, uniqueness, bounded loss, solvency, isolation, replay resistance, and reachability constraints. Avoid tautologies that mirror one implementation variable.

## Build reachable action space

Use handlers to constrain calls to actions and actors that the deployed system permits. Track ghost state independently when the implementation's own accounting is under test. Bound values only where the real system does; include zero, boundary, repeated, reordered, callback, and failure paths deliberately.

## Diagnose counterexamples

First rule out incorrect setup, impossible actor capability, stale deployment assumptions, test-only cheatcodes, and arithmetic in the oracle. Then minimize the sequence while preserving the same required state and consequence. A reproducible assertion failure supports a mechanism; security severity still depends on deployed reachability and impact.

## Preserve replay identity

Record source and test hashes, Foundry version evidence, compiler configuration, named runtime-cache inputs, offline status, selected test pattern, fixed seed, exact argv, exit code, and raw bounded stdout and stderr. Keep FFI disabled and fail closed when the required compiler is not already present in a validated runtime-owned cache. Do not claim determinism when the test consults wall clock, external RPC, unordered foreign state, or unpinned build inputs.
