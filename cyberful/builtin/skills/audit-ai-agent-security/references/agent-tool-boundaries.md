# Agent and Tool Boundaries

## Tool Contract Review

Use narrow typed schemas, reject unknown fields, canonicalize identifiers, and authorize after resolution. Never let the model select raw credentials, arbitrary HTTP headers, unrestricted URLs, shell fragments, recipient identities, or tenant IDs merely because they fit a schema.

Separate tools by capability and identity. A single general-purpose HTTP, browser, code-execution, database, or cloud tool collapses many policy boundaries into model judgment.

## Approval Semantics

Approvals should bind canonical action, resource, recipient, principal, key parameters, and expiry. Display the actual transaction after resolution, not a model-written summary. Material argument changes require renewed approval.

## Confused Deputies

Check whether untrusted content can cause the agent to:

- read a resource and send it to a content-selected destination;
- act in the operator's identity for a different tenant;
- attach credentials to a content-selected URL;
- invoke a privileged tool based on a tool result;
- reinterpret data as a new instruction to another agent;
- move data between otherwise separated connectors.

## Tool-Result Taint

Mark provenance and trust for tool results. Limit what returns to the model, strip active content only with format-aware transformations, and avoid embedding secrets unnecessary for the next decision.

## Rare Chain Hints

- A "read-only" browser can submit forms, follow authenticated links, trigger GET side effects, or leak via URL fetch.
- A filesystem read plus issue/comment writer is a data-exfiltration chain.
- A calendar or email tool may invite, forward, or notify external recipients as a side effect of apparently local changes.
- Tool error strings often contain attacker-controlled server responses and are treated as authoritative diagnostics.
- Delegation can amplify privilege when child agents inherit tools or context not visible in the parent approval.
- An allowlisted tool can accept a reference to an object whose ownership is resolved only inside another service.

## Deterministic Mediation

Place authorization, tenant binding, data-loss rules, recipient policy, network egress, rate and cost bounds, and transaction validation in the tool gateway or application code. Log canonical action and result with sensitive-field redaction.
