# GraphQL Cost and Abuse

## Cost dimensions

Model depth, field count, alias count, list cardinality, nested list multiplication, resolver weight, database rows, remote calls, federation fan-out, subscription fan-out, response bytes, cache misses, and paid downstream actions.

## Controls

Combine maximum depth, maximum aliases and directives, list and page caps, static complexity, dynamic budgets, resolver timeouts, cancellation, concurrency, query allowlists where appropriate, cost-aware rate limits, and response-size limits. A depth-only control does not bound breadth or expensive shallow fields.

## Testing discipline

Analyze schema and code first. Construct a minimal query whose estimated cost differs from a control case. Keep page sizes and repetition small, observe server timing and downstream query behavior in a controlled environment, and stop on instability. Do not prove a theoretical exponential query by executing it at damaging scale.

## Denial of wallet

Include database scans, search, report generation, image or document processing, email/SMS, model tokens, third-party APIs, and federation calls. Bind budgets to user, tenant, operation, and economic resource, not only IP.
