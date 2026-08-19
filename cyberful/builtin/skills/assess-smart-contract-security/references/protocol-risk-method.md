# Protocol risk method

Use this reference when a smart-contract assessment spans code, deployed state, economics, governance, or external systems.

## Model state and authority

Start with assets and conserved quantities, then enumerate every transition that can create, destroy, move, lock, price, or account for them. Record the caller, role derivation, upgrade route, initialization state, timing constraints, external calls, callbacks, and emergency controls for each transition.

Treat administrators, multisigs, timelocks, governance voters, guardians, keepers, relayers, sequencers, oracles, bridges, and off-chain signers as explicit principals. Distinguish intended trust from authority that is merely possible in deployed state.

## Model economic and composability conditions

Record price sources, update cadence, liquidity assumptions, decimal and unit conversions, collateral accounting, rounding direction, fee paths, debt socialization, liquidation incentives, flash liquidity, and dependencies on another protocol's liveness or solvency. State which assumptions an attacker can influence within one transaction, one block, or a longer campaign.

## Grade evidence

Keep documentation claims, source observations, build provenance, deployed bytecode, live storage, transaction traces, and reproduced invariant failures separate. A risk becomes actionable when the required state and authority are supported; it becomes demonstrated only when a controlled reproduction establishes the transition and consequence.
