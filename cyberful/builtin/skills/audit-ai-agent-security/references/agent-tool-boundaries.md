# Agent and Tool Boundaries

## Capability and Identity Record

For every tool, record its typed schema, semantic capability, effective principal, tenant, credentials, selectable resources, destinations, approvals, returned data, retries, rollback, idempotency, and cumulative cost. Separate read, write, execution, communication, financial, IAM, signing, and deployment effects.

Resolve authorization after canonicalizing identifiers. Reject unknown fields. Do not let the model choose raw credentials, arbitrary headers, unrestricted URLs, shell fragments, recipient identities, tenant IDs, plugin locations, or package sources merely because a schema accepts strings.

## Chain Escalation

Test supported chains with synthetic resources and inert destinations:

- filesystem read → issue, email, webhook, browser, or HTTP egress;
- retrieved instruction → privileged tool call or delegated task;
- browser read → authenticated form, link, download, or GET side effect;
- parser fetch → loopback, private-service, or metadata-simulator canary;
- tool error → new tool selection, destination, or argument;
- generated Markdown/HTML/CSV/SQL → downstream interpreter action;
- memory write → later privileged run or different identity;
- child agent → inherited tools, context, credentials, or larger budget;
- fallback/retry → policy or approval enforced only on the primary route;
- tool discovery/schema text → instruction injection or hidden capability selection;
- signing, deployment, IAM, or secret-manager read → controlled marker proof.

Do not mark a chain disproved merely because one payload failed. Verify the prerequisite capability, identity, egress, parser, and downstream consumer first.

## Approval Semantics

Bind approval to the canonical action, principal, tenant, resource, destination or recipient, key parameters, expected side effects, expiry, and bounded retries. Display the resolved transaction rather than a model-written summary. Require renewed approval after material argument changes.

## Tool-Result Taint

Attach provenance and trust to tool results, errors, retrieved chunks, generated artifacts, and cross-agent messages. Return only data required for the next decision. Prevent attacker-controlled text from becoming trusted diagnostics or new instructions.

## Deterministic Mediation

Enforce authorization, tenant binding, data-loss rules, egress, recipient policy, rate, spend, recursion, concurrency, destination validation, and transaction integrity in the gateway or application code. Log canonical action and result with sensitive-field redaction. Keep model refusals and prompt hierarchy as secondary controls.
