# Payment Control Testing

## Preconditions

Confirm the payment environment, rail, instrument, accounts, merchants, beneficiaries, value ceiling, currencies, rate ceiling, prohibited effects, evidence access, reversal path, and operator contacts. Treat a sandbox label as insufficient until the processor and ledger behavior are known.

## Lifecycle evidence

- Authorization: risk decision, reason codes, processor response, reservation, and idempotency record.
- Capture or transfer: state transition, beneficiary binding, ledger posting, and downstream message.
- Settlement or payout: rail reference, settled value, fees, currency conversion, and destination ownership.
- Refund or reversal: original transaction binding, cumulative limit, ledger compensation, and repeated-operation behavior.
- Dispute: eligibility, evidence ownership, provisional credit, final disposition, and double-recovery prevention.

## Discriminating comparisons

Change one dimension at a time: value just below and above a threshold, new and established beneficiary, fresh and established account, one channel versus another, first attempt versus bounded retry, or active versus revoked instrument. Avoid broad combinatorial campaigns.

## Stopping conditions

Stop before real settlement or customer impact, when a synthetic boundary is uncertain, when cleanup cannot be verified, when risk operations requests a halt, or when the next case would add volume without distinguishing a control hypothesis.
