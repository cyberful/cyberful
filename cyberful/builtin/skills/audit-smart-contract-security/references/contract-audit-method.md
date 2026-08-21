# Contract audit method

Use this reference for source-level smart-contract review after architecture and deployment assumptions are explicit.

## Trace by conserved value

For accounting code, write the conserved or monotonic quantity and its unit before tracing branches. Follow deposits, withdrawals, shares, fees, debt, collateral, rewards, liquidation, rounding, and loss realization across every path, including empty and terminal states.

## Treat composition as hostile variation

Model callbacks, reentrancy, fee-on-transfer and rebasing tokens, missing return values, non-standard decimals, ERC hooks, flash liquidity, stale or zero prices, sequencer outages, bridges, proxies, and governance execution. Include revert and partial-progress behavior where external calls can block recovery or settlement.

## Bind source to runtime claims

Record compiler and optimizer settings, libraries, immutable and constructor values, build provenance, deployed bytecode, proxy implementation and admin, initializer state, roles, and live configuration. A source defect is not necessarily reachable in the deployed instance; a safe-looking source tree may not be the deployed implementation.
